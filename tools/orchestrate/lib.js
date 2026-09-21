/**
 * The small things every adapter needs: HTTP with a deadline, polling, shelling
 * out, and a file write that survives Ctrl-C.
 *
 * Nothing here knows about any of the three services. Adapters use these, `run.js`
 * uses the adapters, and only `run.js` prints or touches state — which is what
 * makes a resumed run testable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The Video-editor-MCP checkout this tool lives in. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const STEPS = ["ui-snap", "ugc-farm", "captions", "button", "packshot"];

/** Which services a given set of steps actually needs up. Kept next to STEPS so
 *  the two never drift apart. */
export function servicesFor(steps, { captions = "overlay", serve = true } = {}) {
  const needs = [];
  if (steps.includes("ui-snap")) needs.push("ui-snap");
  if (steps.includes("ugc-farm")) needs.push("ugc-farm");
  if (steps.includes("captions") && captions !== "none") needs.push("captions");
  // The editor only matters if a project gets built and handed to it, which none
  // of these steps do on their own.
  const builds = steps.some((step) => ["captions", "button", "packshot"].includes(step));
  if (serve && builds) needs.push("editor");
  return needs;
}

export class StepError extends Error {
  /** @param {string} message @param {{code?: string, hint?: string, fatal?: boolean}} extra */
  constructor(message, extra = {}) {
    super(message);
    this.name = "StepError";
    this.code = extra.code ?? "step_failed";
    this.hint = extra.hint ?? "";
    // `fatal` means "do not retry and do not continue" — the money branches set it.
    this.fatal = extra.fatal ?? false;
  }
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * fetch with a deadline. Returns the parsed body plus the status, and never throws
 * on a non-2xx — the adapters branch on codes, so an HTTP error is data here.
 *
 * ui-snap answers errors in plain text and ugc-farm in JSON, so the body is parsed
 * by what came back rather than by what was hoped for.
 */
export async function request(url, { method = "GET", body, headers = {}, timeoutMs = 30000, raw = false } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      signal: abort.signal,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    clearTimeout(timer);
    const why = error.name === "AbortError" ? `no answer within ${timeoutMs / 1000}s` : error.message;
    throw new StepError(`${method} ${url} failed: ${why}`, { code: "unreachable" });
  }
  clearTimeout(timer);

  if (raw) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, ok: response.ok, bytes };
  }
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, ok: response.ok, data, text };
}

/**
 * Call `check` until it returns a value that is not null, or the deadline passes.
 * `onTick` gets the elapsed seconds so a long wait can show it is still alive.
 */
export async function poll(check, { everyMs, deadlineMs, onTick } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const answer = await check();
    if (answer !== null && answer !== undefined) return answer;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadlineMs) {
      throw new StepError(`gave up after ${Math.round(elapsed / 1000)}s`, { code: "timeout" });
    }
    onTick?.(Math.round(elapsed / 1000));
    await sleep(everyMs);
  }
}

/** Run a command and hand back its stdout. Throws with the tail of stderr, which is
 *  the part that says what went wrong — ffmpeg's first twenty lines never do. */
export function sh(command, args, { cwd, timeoutMs = 0, input } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs || undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error.stderr ?? "").trim().split("\n").slice(-6).join("\n");
    throw new StepError(`${command} failed: ${stderr || error.message}`);
  }
}

export function ffprobe(file) {
  if (!existsSync(file)) throw new StepError(`no such file: ${file}`);
  const raw = sh("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,pix_fmt,codec_name",
    "-show_entries", "format=duration",
    "-of", "json", file,
  ]);
  const info = JSON.parse(raw);
  const stream = info.streams?.[0] ?? {};
  return {
    duration: Number(info.format?.duration ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    pixFmt: stream.pix_fmt ?? "",
    codec: stream.codec_name ?? "",
  };
}

/** Write via a temp file and rename, so an interrupt never leaves half a file
 *  behind. `run.json` is written after every step that could cost money. */
export function writeJson(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, target);
}

export const round = (n, places = 3) => Number(n.toFixed(places));

/**
 * The colour in the four corners of a clip, at its midpoint.
 *
 * Used to fill the letterbox bars around a clip whose shape does not match the
 * frame. Four agreeing corners is the evidence that there is a flat backdrop worth
 * copying; when they disagree the corners carry picture, and guessing would be
 * worse than leaving it alone — so that is reported rather than papered over.
 *
 * @returns {{color: string, agreed: boolean, seen: string[]}}
 */
export function sampleCorners(file, duration) {
  const at = duration > 0 ? duration / 2 : 0;
  const corners = ["0:0", "iw-8:0", "0:ih-8", "iw-8:ih-8"];
  const counts = new Map();

  for (const xy of corners) {
    const rgb = execFileSync("ffmpeg", [
      "-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1",
      "-vf", `crop=8:8:${xy},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { maxBuffer: 1024 });
    if (rgb.length < 3) throw new StepError(`could not read a frame from ${file} at ${at.toFixed(2)}s`);
    const hex = `#${rgb.subarray(0, 3).toString("hex")}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    color: ranked[0][0],
    agreed: ranked[0][1] === corners.length,
    seen: ranked.map(([hex, n]) => `${hex} x${n}`),
  };
}
