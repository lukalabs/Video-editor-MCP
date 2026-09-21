#!/usr/bin/env node
/**
 * One prompt, one editable project.
 *
 *   orchestrate start
 *
 * brings the three servers up and then asks what you want to make, which is the
 * way this is meant to be used. Everything below is the same thing, scriptable.
 *
 *   orchestrate make "a redhead woman in a sunny dorm room says […], holding her
 *                     phone with the Replika Memory screen on it, TikTok subtitles,
 *                     a 'Try Replika now' button at the end, and the packshot"
 *
 * It asks Gemini what the sentence means, renders the app screen from ui-snap,
 * films it with ugc-farm, transcribes it, and builds a project whose captions,
 * button and packshot are real layers you can still edit.
 *
 *   orchestrate make "<prompt>"     the whole chain
 *   orchestrate resume <run-id>     continue one, without paying twice
 *   orchestrate plan "<prompt>"     just the planning, free
 *   orchestrate doctor              is everything running?
 */
import { readFileSync } from "node:fs";

import { REPO, servicesFor, StepError, STEPS } from "./lib.js";
import { findGeminiKey, makePlan, readTags } from "./plan.js";
import { preflight, report, UGC_FARM_DIR } from "./preflight.js";

const CAPTION_MODES = ["overlay", "layer", "none"];
const RESOLUTIONS = ["480p", "720p", "1080p"];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function die(message, hint = "") {
  console.error(`error: ${message}`);
  if (hint) console.error(`       ${hint}`);
  process.exit(1);
}

const pick = (value, allowed, fallback, flag) => {
  if (value === undefined || value === true) return fallback;
  if (!allowed.includes(value)) die(`--${flag} must be one of ${allowed.join(", ")} (got "${value}")`);
  return value;
};

/** `--duration`, checked against the model's range rather than quietly clamped. */
const readDuration = (value) => {
  if (value === undefined) return 0;
  const seconds = Number(value === true ? NaN : value);
  if (!Number.isFinite(seconds)) die("--duration needs a number of seconds");
  if (seconds < 4 || seconds > 30) {
    die(`--duration must be between 4 and 30 seconds (got ${seconds})`,
        "longer scripts split into parts on their own");
  }
  return Math.round(seconds);
};

/** Every flag, resolved once, so no adapter has to re-read argv. */
export function readFlags(args) {
  const size = String(args.size ?? "1080x1920");
  const [width, height] = size.split("x").map(Number);
  if (!width || !height) die(`--size must look like 1080x1920 (got "${size}")`);

  const only = args.only === undefined || args.only === true
    ? []
    : String(args.only).split(",").map((s) => s.trim()).filter(Boolean);
  for (const step of only) {
    if (!STEPS.includes(step)) die(`--only does not know "${step}"`, `steps are ${STEPS.join(", ")}`);
  }

  return {
    dryRun: Boolean(args["dry-run"]),
    spend: Boolean(args.spend),
    media: args.media === true ? die("--media needs a file") : args.media,
    only,
    captions: pick(args.captions, CAPTION_MODES, "overlay", "captions"),
    preset: String(args.preset === undefined || args.preset === true ? "hormozi" : args.preset),
    resolution: pick(args.resolution, RESOLUTIONS, "1080p", "resolution"),
    width,
    height,
    fps: Number(args.fps ?? 30),
    name: args.name === true ? "" : args.name,
    buttonLead: Number(args["button-lead"] ?? 0) || 0,
    duration: readDuration(args.duration),
    flattenColor: args["flatten-color"] === true ? "#16181D" : String(args["flatten-color"] ?? "#16181D"),
    serve: !args["no-serve"],
    open: Boolean(args.open),
    json: Boolean(args.json),
    resubmitPart: Number(args["resubmit-part"] ?? 0) || 0,
    keep: Number(args.keep ?? 8),
  };
}

/* -------------------------------------------------------------- the commands */

async function cmdDoctor(args) {
  const flags = readFlags(args);
  const { source } = findGeminiKey({ repo: REPO, ugcFarmDir: UGC_FARM_DIR });
  console.log("checking what this chain needs\n");
  const checks = await preflight({
    repo: REPO,
    needs: flags.only.length ? servicesFor(flags.only, flags) : [],
    geminiKeySource: source,
  });
  const allWell = report(checks);
  console.log(allWell ? "\nall good." : "\nfix the FAILs above, then run this again.");
  process.exit(allWell ? 0 : 2);
}

async function cmdPlan(args) {
  const prompt = args._[1] ?? readStdin();
  if (!prompt) die('give me a prompt: orchestrate plan "…"');
  const flags = readFlags(args);
  const { key, source } = findGeminiKey({ repo: REPO, ugcFarmDir: UGC_FARM_DIR });
  if (!key) die("no GEMINI_API_KEY", `looked in the environment, ${REPO}/.env and ${UGC_FARM_DIR}/.env`);

  const tags = readTags(prompt);
  const plan = await makePlan(prompt, { key, tags, hasMedia: Boolean(flags.media) });
  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`planner   Gemini, key from ${source}`);
  console.log(`tags      ${tags.length ? tags.join(", ") : "(none — the planner chose)"}`);
  console.log(`steps     ${plan.steps.join(" -> ")}`);
  const { briefLines } = await import("./brief.js");
  for (const line of briefLines(plan, flags)) console.log(line);
  console.log("the planner's own answer, in full:\n");
  console.log(JSON.stringify(plan, null, 2));
}

/**
 * The stop on the plan, for the one-shot command.
 *
 * `--yes` waives it, and so does the absence of a terminal: a run in a script or a
 * pipe has nobody to answer, and blocking there would turn every unattended run
 * into a hang. Neither waiver spends anything on its own — `--spend` is still what
 * buys a render.
 */
function askToProceed(args) {
  if (args.yes || !process.stdin.isTTY) return null;
  return async () => {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write("run this? [y/N] ▸ ");
    // `rl.question` is the obvious way and it is wrong here, for the same reason
    // the session has its own reader: piped input closes stdin as soon as the
    // answer is written, and the close arrives while the line is still buffered.
    // Racing them rejects on an answer that was given — a typed "y" read as a no,
    // which is the one mistake a confirmation must never make. Waiting for `line`
    // and treating close as no only when no line came fixes both ends of it.
    const answer = await new Promise((resolve) => {
      let got = null;
      rl.on("line", (line) => { got = line; rl.close(); });
      rl.on("close", () => resolve(got));
    });
    if (answer === null) process.stdout.write("\n");
    return String(answer ?? "").trim().toLowerCase() === "y";
  };
}

/** A prompt piped in, if there is one.
 *
 *  Guarded by isTTY: reading fd 0 from an interactive terminal blocks forever, so
 *  `orchestrate make` with no argument would sit there looking like a hang rather
 *  than printing what it wanted. */
function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

async function cmdMake(args) {
  const { runMake } = await import("./run.js");
  const prompt = args._[1] ?? readStdin();
  if (!prompt) die('give me a prompt: orchestrate make "…"');
  await runMake(prompt, { ...readFlags(args), confirm: askToProceed(args) });
}

async function cmdResume(args) {
  const { runResume } = await import("./run.js");
  const runId = args._[1];
  if (!runId) die("which run? orchestrate resume <run-id>");
  await runResume(runId, readFlags(args));
}

async function cmdStart(args) {
  const { runSession } = await import("./session.js");
  await runSession(readFlags(args));
}

async function cmdStop() {
  const { runStop } = await import("./session.js");
  runStop();
}

const COMMANDS = {
  start: cmdStart,
  stop: cmdStop,
  make: cmdMake,
  resume: cmdResume,
  plan: cmdPlan,
  doctor: cmdDoctor,
};

/* --------------------------------------------------------------------- main */

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || !COMMANDS[command]) {
  console.error(`usage: orchestrate <${Object.keys(COMMANDS).join("|")}> [...]`);
  console.error("");
  console.error("  orchestrate start              bring everything up, then just ask you what to make");
  console.error("  orchestrate stop               shut the servers down");
  console.error('  orchestrate make "<prompt>"    one run [--dry-run] [--spend] [--media <file>]');
  console.error("  orchestrate resume <run-id>    continue one, without paying twice");
  console.error('  orchestrate plan "<prompt>"    just the planning, and the plan. Free');
  console.error("  orchestrate doctor             is everything running?");
  console.error("");
  console.error("  make shows the plan and waits for a yes. --yes skips that stop.");
  console.error("  --duration <4-30> sets the clip length instead of the script deciding.");
  process.exit(1);
}

try {
  await COMMANDS[command](args);
} catch (error) {
  if (error instanceof StepError) die(error.message, error.hint);
  throw error;
}
