/**
 * The run itself: what happens, in what order, and what is written down.
 *
 * The adapters do the work and say nothing. This file decides, prints, and records
 * — which is why a run can be picked up again from a crash, a restart or a day
 * later without paying for the same seconds twice.
 *
 * The rule that protects the money: a part the service already lists as rendered
 * is never submitted again. Everything else is a convenience.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import { REPO, StepError, ffprobe, round, sampleCorners, servicesFor, sh, writeJson } from "./lib.js";
import { briefLines, promptLines } from "./brief.js";
import { Farm, partFile } from "./ugc-farm.js";
import { findGeminiKey, makePlan, readTags } from "./plan.js";
import { preflight, report, UGC_FARM, UGC_FARM_DIR, UI_SNAP } from "./preflight.js";
import { check, commands, describe as describeLayout, layout } from "./timeline.js";
import { shoot } from "./ui-snap.js";
import { transcribe } from "./captions.js";

const RUNS = () => resolve(REPO, "storage/orchestrate");
const log = (line = "") => console.log(line);

const newRunId = () => {
  // Local time, not UTC: the folder name should match the clock you looked at.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${day}-${time}-${randomBytes(3).toString("hex")}`;
};

/* -------------------------------------------------------------------- state */

const save = (state) => {
  state.updatedAt = new Date().toISOString();
  writeJson(join(state.dir, "run.json"), { ...state, dir: undefined });
};

/**
 * The daily cap, for the brief — best effort and never fatal.
 *
 * The brief is printed before preflight, deliberately: somebody should be able to
 * read what a run would do without three servers being up first. So a service that
 * is not answering yet just means the cap line is missing, not that the plan is.
 */
async function farmLimits(steps, flags) {
  if (!steps.includes("ugc-farm") || flags.media) return null;
  try {
    const farm = new Farm({ baseUrl: UGC_FARM, password: process.env.UGC_FARM_PASSWORD ?? "", log: () => {} });
    return await farm.limits();
  } catch {
    return null;
  }
}

/** The length asked for: the flag first, then the prompt, then nothing. */
function askedDuration(state, flags) {
  return flags.duration || Number(state.plan?.ugc?.durationSeconds) || 0;
}

function loadRun(runId) {
  const dir = join(RUNS(), runId);
  const file = join(dir, "run.json");
  if (!existsSync(file)) {
    throw new StepError(`no run called ${runId}`, { hint: `runs live in ${RUNS()}` });
  }
  return { ...JSON.parse(readFileSync(file, "utf8")), dir };
}

const stage = (state, name) => (state.stages[name] ??= { status: "pending" });

/* ------------------------------------------------------------------ helpers */

function runCli(args) {
  return sh("node", [resolve(REPO, "tools/project-cli/index.js"), ...args], { cwd: REPO });
}

/** Render the button locally — no queue, no service, just Chrome and ffmpeg. */
function renderButton(props, { dir, width, height, fps, seconds }) {
  const out = join(dir, "button.webm");
  if (!existsSync(out)) {
    // From the component library's own folder, the way project-cli runs it. The
    // Motion Canvas plugin writes its frames to "./output" relative to the working
    // directory, so run it from anywhere else and the frames land somewhere the
    // script never looks — reported as "No frames were written" after a render the
    // browser says went fine.
    sh("node", [
      "scripts/render.mjs",
      "--component", "button",
      "--fps", String(fps), "--width", String(width), "--height", String(height),
      "--props", JSON.stringify({ ...props, durationInSeconds: seconds, holdToEnd: true }),
      "--out", out,
    ], { cwd: resolve(REPO, "packages/component-library"), timeoutMs: 10 * 60 * 1000 });
  }
  return { file: out, duration: ffprobe(out).duration };
}

/**
 * `project-cli serve` copies the project and every clip into the folder the editor
 * serves, and never takes them out again. A dozen runs is gigabytes sitting inside
 * the dev server, so the oldest are dropped.
 */
function prune(keep) {
  const folder = resolve(REPO, "apps/editor/apps/web/public/cli-projects");
  if (!existsSync(folder) || keep <= 0) return;
  const entries = readdirSync(folder)
    .map((name) => ({ name, path: join(folder, name) }))
    .filter((entry) => statSync(entry.path).isDirectory())
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  for (const old of entries.slice(keep)) {
    rmSync(old.path, { recursive: true, force: true });
    log(`  pruned an old served copy: ${old.name}`);
  }
}

/* ------------------------------------------------------------------- stages */

async function doUiSnap(state, flags) {
  const own = stage(state, "ui-snap");
  if (own.status === "done" && existsSync(join(state.dir, "screen.png"))) {
    log("  already taken");
    return;
  }
  const shot = await shoot(state.plan.uiSnap, {
    baseUrl: UI_SNAP, dir: state.dir, flattenColor: flags.flattenColor, log,
  });
  Object.assign(own, {
    status: "done",
    shot: "shot.png",
    screen: "screen.png",
    width: shot.width,
    height: shot.height,
    warnings: shot.warnings,
  });
  save(state);
}

async function doUgcFarm(state, flags) {
  const own = stage(state, "ugc-farm");
  const farm = new Farm({ baseUrl: UGC_FARM, password: process.env.UGC_FARM_PASSWORD ?? "", log });
  own.renders ??= {};

  if (!own.projectId) {
    own.projectId = await farm.start(state.plan.ugc);
    own.status = "running";
    save(state);                                   // before anything else can go wrong

    const screen = state.stages["ui-snap"]?.screen;
    await farm.setScene(own.projectId, {
      screenPng: screen ? join(state.dir, screen) : "",
      describes: state.plan.ugc.screen_describes,
      durationSeconds: askedDuration(state, flags),
    });
    save(state);
  } else {
    log(`  continuing project ${own.projectId}`);
  }

  if (!own.parts) {
    const parts = await farm.writePrompt(own.projectId);
    own.parts = parts.length;
    own.promptErrors = parts.reduce((total, part) => total + (part.errors ?? 0), 0);
    save(state);
  }

  // The server is the truth about what has already been paid for. Anything it
  // lists as rendered is claimed here, before a single new submission.
  const project = await farm.project(own.projectId);
  for (const record of project.renders ?? []) {
    const already = own.renders[record.part];
    if (already?.status === "done" && existsSync(join(state.dir, already.file))) continue;
    const local = partFile(state.dir, record.part, record.media);
    if (!existsSync(local)) {
      log(`  part ${record.part} was already rendered — fetching it`);
      await farm.download(record.media, local);
    }
    own.renders[record.part] = {
      status: "done", file: local.slice(state.dir.length + 1),
      media: record.media, elapsedS: record.elapsed_s,
    };
  }
  save(state);

  const limits = await farm.limits();
  const missing = [];
  for (let part = 1; part <= own.parts; part += 1) {
    if (own.renders[part]?.status !== "done") missing.push(part);
  }

  log("");
  log(`  ${own.parts} part(s), ${own.parts - missing.length} already rendered`);
  log(`  cap       ${limits.note}`);
  for (const part of missing) {
    const dry = await farm.dryRun(own.projectId, part, flags.resolution);
    log(`  part ${part}   ${dry.model} ${JSON.stringify(dry.params)}`);
    log(`            ${dry.references.length} reference image(s)`);
  }
  log(`  review    ${UGC_FARM}/p/${own.projectId}`);

  // The beats, before the render rather than after it. The payload above says what
  // is being bought; this says what it will contain, which is the thing actually
  // worth reading twice — a prompt can be a valid submission and still describe the
  // wrong video.
  const written = (await farm.project(own.projectId)).prompts ?? [];
  const forSale = written.filter((entry) => missing.includes(entry.part));
  if (forSale.length) {
    log("");
    log("  what the render will contain:");
    for (const line of promptLines(forSale)) log(line);
    const errors = forSale.reduce((total, entry) => total + (entry.errors ?? 0), 0);
    if (errors) {
      log("");
      log(`  ! ${errors} unresolved error(s) in the prompt above.`);
      log(`    read them at ${UGC_FARM}/p/${own.projectId} before paying for it.`);
    }
  }
  log("");

  if (!missing.length) {
    own.status = "done";
    save(state);
    return;
  }

  if (flags.dryRun) {
    own.status = "partial";
    save(state);
    throw new DryRunStop(missing.length);
  }
  if (!flags.spend) {
    own.status = "partial";
    save(state);
    throw new StepError(
      `${missing.length} part(s) still need rendering, and rendering costs money`,
      { hint: `add --spend to go ahead, or "orchestrate resume ${state.runId} --dry-run" to look first` },
    );
  }
  if (limits.cap_reached) {
    own.status = "partial";
    save(state);
    throw new StepError(`the daily render cap is used up — ${limits.note}`, {
      code: "cap_reached", fatal: true,
      hint: `resume tomorrow: orchestrate resume ${state.runId} --spend`,
    });
  }

  for (const part of missing) {
    // Parts after the first extend the one before, so the previous has to be
    // accepted before this one is even allowed to start.
    if (part > 1) await farm.accept(own.projectId, part - 1).catch(() => {});

    const record = await farm.render(own.projectId, part, {
      resolution: flags.resolution,
      onSubmit: (jobId) => {
        own.renders[part] = { status: "submitted", jobId, submittedAt: new Date().toISOString() };
        state.money.rendersSubmitted += 1;
        save(state);                               // on disk before the first poll
      },
    });
    const local = partFile(state.dir, part, record.media);
    const { bytes } = await farm.download(record.media, local);
    own.renders[part] = {
      status: "done", file: local.slice(state.dir.length + 1),
      media: record.media, elapsedS: record.elapsed_s,
    };
    state.money.rendersSucceeded += 1;
    save(state);
    log(`  part ${part} done in ${Math.round(record.elapsed_s)}s, ${(bytes / 1e6).toFixed(1)} MB`);
    await farm.accept(own.projectId, part).catch(() => {});
  }
  own.status = "done";
  save(state);
}

function doTimeline(state, flags) {
  const own = stage(state, "timeline");
  const plan = state.plan;

  // The clips, in order: either what ugc-farm made, or the one you brought.
  const farmStage = state.stages["ugc-farm"] ?? {};
  const files = state.media
    ? [resolve(state.media)]
    : Object.keys(farmStage.renders ?? {})
        .map(Number).sort((a, b) => a - b)
        .map((part) => join(state.dir, farmStage.renders[part].file));
  if (!files.length) throw new StepError("there is no footage to build a timeline from");

  const durations = files.map((file) => ffprobe(file).duration);
  const wantsPackshot = plan.steps.includes("packshot");
  const wantsButton = plan.steps.includes("button");

  const packshotMedia = resolve(REPO, plan.packshot.media);
  if (wantsPackshot && !existsSync(packshotMedia)) {
    throw new StepError(`no packshot at ${packshotMedia}`, { hint: "point --media at another file, or drop @packshot" });
  }
  const packshot = wantsPackshot ? ffprobe(packshotMedia).duration : 0;

  // The bars appear around the packshot, so the colour to fill them with is the
  // packshot's own. project-cli's `--color auto` samples the first footage clip
  // instead — a room, whose corners disagree — which is why this is done here.
  let backdrop = plan.packshot.backdrop;
  if (wantsPackshot) {
    const corners = sampleCorners(packshotMedia, packshot);
    if (corners.agreed) {
      backdrop = corners.color;
    } else {
      log(`  backdrop  the packshot's corners disagree (${corners.seen.join(", ")}) — `
        + `using ${backdrop} from the plan`);
    }
  }

  let button = { file: "", duration: 0 };
  if (wantsButton) {
    const seconds = flags.buttonLead || plan.button.leadSeconds;
    log("  rendering the button (local, free)…");
    button = renderButton(plan.button.props, {
      dir: state.dir, width: flags.width, height: flags.height, fps: flags.fps, seconds,
    });
    log(`  button    ${round(button.duration)}s (asked for ${seconds}s — the file's length is what counts)`);
  }

  const shape = layout({ parts: durations, packshot, button: button.duration });
  log("");
  log(describeLayout(shape));
  const problems = check(shape);
  if (problems.length) {
    for (const problem of problems) log(`  ! ${problem}`);
    throw new StepError("the timeline does not add up", { hint: problems[0] });
  }
  log("  ok        nothing overlaps");
  log("");

  const project = join(state.dir, "draft.json");
  const calls = commands(shape, {
    project,
    media: files,
    packshotMedia,
    buttonFile: button.file,
    buttonProps: { ...plan.button.props, durationInSeconds: round(button.duration), holdToEnd: true },
    cues: state.stages.captions?.cues ? join(state.dir, "cues.json") : null,
    captions: flags.captions,
    preset: flags.preset === "hormozi" ? plan.captions.preset : flags.preset,
    backdrop,
    width: flags.width,
    height: flags.height,
    fps: flags.fps,
    name: flags.name || plan.title,
  });

  if (flags.dryRun) {
    log("  it would run:");
    for (const call of calls) log(`    project-cli ${call.join(" ")}`);
    own.status = "pending";
    save(state);
    return null;
  }

  for (const call of calls) {
    log(`  ${call[0]}`);
    runCli(call);
  }
  const built = JSON.parse(readFileSync(project, "utf8"));
  const drift = Math.abs(built.timeline.duration - shape.end);
  if (drift > 1e-3) {
    log(`  ! the built project ends at ${round(built.timeline.duration)}s, not ${shape.end}s`);
  }
  Object.assign(own, { status: "done", project: "draft.json", end: shape.end, backdrop, layout: shape });
  save(state);
  return project;
}

/* -------------------------------------------------------------- the two ways */

class DryRunStop extends Error {
  constructor(parts) {
    super("dry run");
    this.parts = parts;
  }
}

async function execute(state, flags) {
  const steps = state.plan.steps.filter((step) => !flags.only.length || flags.only.includes(step));

  if (steps.includes("ui-snap")) {
    log("ui-snap");
    await doUiSnap(state, flags);
  }

  let stopped = null;
  if (steps.includes("ugc-farm")) {
    log("\nugc-farm");
    try {
      await doUgcFarm(state, flags);
    } catch (error) {
      if (!(error instanceof DryRunStop)) throw error;
      stopped = error;
    }
  }

  const haveFootage = state.media
    || Object.values(state.stages["ugc-farm"]?.renders ?? {}).some((r) => r.status === "done");

  if (steps.includes("captions") && flags.captions !== "none" && haveFootage && !stopped) {
    log("\ncaptions");
    const farmStage = state.stages["ugc-farm"] ?? {};
    const clips = state.media
      ? [{ file: resolve(state.media), at: 0 }]
      : Object.keys(farmStage.renders ?? {}).map(Number).sort((a, b) => a - b)
          .reduce((acc, part) => {
            const file = join(state.dir, farmStage.renders[part].file);
            const at = acc.length ? round(acc.at + acc[acc.length - 1].length) : 0;
            acc.push({ file, at, length: ffprobe(file).duration });
            acc.at = at;
            return acc;
          }, []);
    let at = 0;
    const timed = clips.map((clip) => {
      const entry = { file: clip.file, at: round(at) };
      at += ffprobe(clip.file).duration;
      return entry;
    });
    const cues = transcribe({
      clips: timed, repo: REPO, dir: state.dir, log,
      spoken: state.plan?.ugc?.script ?? "",
    });
    Object.assign(stage(state, "captions"), { status: cues ? "done" : "skipped", cues: cues ? "cues.json" : null });
    save(state);
  } else if (steps.includes("captions") && !haveFootage) {
    log("\ncaptions  skipped — no clip yet");
  }

  let project = null;
  if (haveFootage && (steps.includes("button") || steps.includes("packshot") || steps.includes("captions"))) {
    log("\ntimeline");
    project = doTimeline(state, flags);
  }

  if (stopped) {
    log("");
    log(`dry run: nothing was rendered. ${stopped.parts} part(s) are waiting.`);
    log("  Gemini was called — once here, a few times inside ugc-farm. Cents, not dollars.");
    log("  The ugc-farm project is real and reusable, so nothing above repeats:");
    log(`    orchestrate resume ${state.runId} --spend`);
    return;
  }

  if (project && flags.serve) {
    log("\neditor");
    prune(flags.keep);
    const output = runCli(["serve", project, ...(flags.open ? ["--open"] : [])]);
    log(output.trim().split("\n").map((line) => `  ${line}`).join("\n"));
  }

  log("");
  log(`done. everything is in ${state.dir}`);
  if (state.money.rendersSubmitted) {
    log(`  ${state.money.rendersSucceeded}/${state.money.rendersSubmitted} paid render(s) landed`);
  }
}

export async function runMake(prompt, flags) {
  const { key, source } = findGeminiKey({ repo: REPO, ugcFarmDir: UGC_FARM_DIR });
  const tags = readTags(prompt);

  log("planning");
  const plan = await makePlan(prompt, { key, tags, hasMedia: Boolean(flags.media) });
  const steps = plan.steps.filter((step) => !flags.only.length || flags.only.includes(step));
  log(`  key from  ${source}`);
  log(`  tags      ${tags.length ? tags.join(", ") : "(none — the planner chose)"}`);
  log(`  steps     ${steps.join(" -> ")}`);
  log(`  script    ${plan.ugc.script.split(/\s+/).length} words`);
  for (const note of plan.notes) log(`  note      ${note}`);

  // The plan, in full, before anything is made or bought. `confirm` is how the
  // caller turns that into a stop: the session asks, a script with --yes does not,
  // and a pipe with no terminal cannot be asked and so is never held up.
  const planned = { ...plan, steps };
  for (const line of briefLines(planned, flags, { limits: await farmLimits(steps, flags) })) log(line);
  if (flags.confirm && !(await flags.confirm(planned))) {
    throw new StepError("stopped before anything ran", { hint: "nothing was made and nothing was spent" });
  }

  log("\nchecking what this needs");
  const checks = await preflight({
    repo: REPO,
    needs: servicesFor(steps, flags),
    geminiKeySource: source,
    password: process.env.UGC_FARM_PASSWORD ?? "",
  });
  if (!report(checks)) {
    throw new StepError("something this run needs is not running", { hint: "fix the FAILs above" });
  }

  const runId = newRunId();
  const dir = join(RUNS(), runId);
  mkdirSync(dir, { recursive: true });
  const state = {
    runId, version: 1, dir,
    createdAt: new Date().toISOString(), updatedAt: "",
    prompt, tags, plan,
    media: flags.media ? resolve(flags.media) : null,
    flags: {
      captions: flags.captions, preset: flags.preset, resolution: flags.resolution,
      size: `${flags.width}x${flags.height}`, fps: flags.fps, dryRun: flags.dryRun,
    },
    stages: {},
    money: { rendersSubmitted: 0, rendersSucceeded: 0 },
  };
  writeJson(join(dir, "step-plan.json"), plan);
  writeFileSync(join(dir, "prompt.txt"), `${prompt}\n`);
  save(state);
  log(`\nrun ${runId}`);

  await execute(state, flags);
  return runId;
}

export async function runResume(runId, flags) {
  const state = loadRun(runId);
  log(`run ${state.runId}, started ${state.createdAt}`);
  log(`  steps     ${state.plan.steps.join(" -> ")}`);
  for (const [name, own] of Object.entries(state.stages)) log(`  ${name.padEnd(9)} ${own.status}`);
  if (state.money.rendersSubmitted) {
    log(`  paid for  ${state.money.rendersSubmitted} render(s), ${state.money.rendersSucceeded} landed`);
  }

  log("\nchecking what this needs");
  const steps = state.plan.steps.filter((step) => !flags.only.length || flags.only.includes(step));
  const { source } = findGeminiKey({ repo: REPO, ugcFarmDir: UGC_FARM_DIR });
  const checks = await preflight({
    repo: REPO,
    needs: servicesFor(steps, flags),
    geminiKeySource: source,
    password: process.env.UGC_FARM_PASSWORD ?? "",
  });
  if (!report(checks)) throw new StepError("something this run needs is not running");

  log("");
  await execute(state, flags);
  return state.runId;
}
