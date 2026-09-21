/**
 * Is everything this chain needs actually running?
 *
 * Checked before anything is generated, because the alternative is finding out
 * nine minutes and one paid render later. Every failure prints the command that
 * fixes it. Nothing is started for you: these are your servers, in your terminals,
 * where you can read their logs.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { request, sh } from "./lib.js";

export const UI_SNAP = process.env.UI_SNAP_URL ?? "http://localhost:3000";
export const UGC_FARM = process.env.UGC_FARM_URL ?? "http://localhost:8765";
export const EDITOR = process.env.EDITOR_URL ?? "http://localhost:5173";

export const UI_SNAP_DIR = process.env.UI_SNAP_DIR ?? "/Users/stvrhunter/scripts-code/ui-animation/ui-snap";
export const UGC_FARM_DIR = process.env.UGC_FARM_DIR ?? "/Users/stvrhunter/scripts-code/ugc-farm";

const ok = (name, note = "") => ({ name, ok: true, note });
const bad = (name, why, fix) => ({ name, ok: false, why, fix });
const warn = (name, why, fix) => ({ name, ok: true, warn: true, why, fix });

function haveBinary(name) {
  try {
    sh("which", [name]);
    return true;
  } catch {
    return false;
  }
}

async function checkUiSnap() {
  const name = "ui-snap";
  const fix = `cd ${UI_SNAP_DIR} && bun dev`;
  let answer;
  try {
    // This probe launches Chrome on the other side, so give it room.
    answer = await request(`${UI_SNAP}/api/shot`, { timeoutMs: 20000 });
  } catch (error) {
    return bad(name, error.message, fix);
  }
  // The route answers 200 whether or not it can actually shoot, so the body is
  // the answer and the status is not.
  if (answer.data?.available === true) return ok(name, UI_SNAP);
  const why = answer.data?.hint ? `not available — ${answer.data.hint}` : `unexpected answer: ${answer.text?.slice(0, 120)}`;
  return bad(name, why, fix);
}

async function checkUgcFarm() {
  const name = "ugc-farm";
  const fix = `cd ${UGC_FARM_DIR} && python3 ugc.py serve`;
  try {
    const answer = await request(`${UGC_FARM}/healthz`, { timeoutMs: 8000 });
    if (answer.data?.ok !== true) return bad(name, `unhealthy: ${answer.text?.slice(0, 120)}`, fix);
    return ok(name, `${UGC_FARM} — ${answer.data.projects} projects`);
  } catch (error) {
    return bad(name, error.message, fix);
  }
}

async function checkUgcFarmKeys(password) {
  const name = "ugc-farm keys";
  const fix = `set BYTEPLUS_API_KEY and GEMINI_API_KEY in ${UGC_FARM_DIR}/.env`;
  try {
    const headers = password ? { "X-App-Password": password } : {};
    const answer = await request(`${UGC_FARM}/api/models`, { headers, timeoutMs: 8000 });
    const warnings = answer.data?.warnings ?? [];
    // Only the two keys the service path actually uses are blocking; the ledger
    // warning is about S3 and falls back to a file on disk.
    const blocking = warnings.filter((w) => /BYTEPLUS|ARK_API_KEY|GEMINI/i.test(w));
    if (blocking.length) return bad(name, blocking.join("; "), fix);
    if (warnings.length) return warn(name, warnings.join("; "), "harmless locally — the spend log falls back to a file");
    return ok(name);
  } catch (error) {
    return bad(name, error.message, fix);
  }
}

async function checkEditor() {
  const name = "editor";
  const fix = "cd apps/editor && pnpm --filter @openreel/web dev";
  try {
    const answer = await request(EDITOR, { timeoutMs: 8000 });
    if (!answer.ok) return bad(name, `answered ${answer.status}`, fix);
    return ok(name, EDITOR);
  } catch (error) {
    return bad(name, error.message, fix);
  }
}

function checkChrome() {
  const name = "Chrome";
  const paths = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  const found = paths.find((path) => existsSync(path));
  // Both halves of the chain drive it: playwright in ui-snap, puppeteer in the
  // component library. One missing Chrome breaks the screenshot and the button.
  return found
    ? ok(name, found)
    : bad(name, "not found", "install Google Chrome, or set CHROME_PATH");
}

/**
 * @param {{repo: string, needs?: string[], geminiKeySource?: string, password?: string}} options
 */
export async function preflight({ repo, needs = [], geminiKeySource = "", password = "" }) {
  const wants = (name) => needs.length === 0 || needs.includes(name);
  const checks = [];

  for (const binary of ["ffmpeg", "ffprobe"]) {
    checks.push(haveBinary(binary) ? ok(binary) : bad(binary, "not on PATH", "brew install ffmpeg"));
  }
  checks.push(checkChrome());

  checks.push(geminiKeySource
    ? ok("GEMINI_API_KEY", `found in ${geminiKeySource}`)
    : bad("GEMINI_API_KEY", "not found",
          `export GEMINI_API_KEY=…, or add it to ${repo}/.env`));

  const componentDeps = resolve(repo, "packages/component-library/node_modules");
  checks.push(existsSync(componentDeps)
    ? ok("component-library deps")
    : bad("component-library deps", "not installed",
          "cd packages/component-library && npm install"));

  if (wants("captions")) {
    const venv = resolve(repo, "storage/caption-work/venv/bin/python");
    checks.push(existsSync(venv)
      ? ok("whisper venv")
      : bad("whisper venv", "not created",
            "python3 -m venv storage/caption-work/venv && "
            + "storage/caption-work/venv/bin/pip install -r tools/short-form-captions/requirements.txt"));

    const weights = resolve(process.env.HOME ?? "",
      ".cache/huggingface/hub/models--Systran--faster-whisper-large-v3");
    if (!existsSync(weights)) {
      checks.push(warn("whisper weights", "not downloaded yet",
        "the first captions run pulls ~3 GB and looks exactly like a hang"));
    }
  }

  if (wants("ui-snap")) checks.push(await checkUiSnap());
  if (wants("ugc-farm")) {
    checks.push(await checkUgcFarm());
    checks.push(await checkUgcFarmKeys(password));
  }
  if (wants("editor")) checks.push(await checkEditor());

  return checks;
}

export function report(checks, { log = console.log } = {}) {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    const mark = check.ok ? (check.warn ? "warn" : "  ok") : "FAIL";
    const tail = check.ok ? (check.note ?? check.why ?? "") : check.why;
    log(`  ${mark}  ${check.name.padEnd(width)}  ${tail}`);
    if (check.warn || !check.ok) log(`        ${" ".repeat(width)}  ${check.fix}`);
  }
  return checks.every((check) => check.ok);
}
