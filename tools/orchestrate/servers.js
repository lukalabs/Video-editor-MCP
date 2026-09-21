/**
 * Starting and stopping the three servers this chain talks to.
 *
 * `doctor` deliberately starts nothing — when you are debugging, a server you
 * started yourself in a terminal you can read is worth more than a tidy one-liner.
 * This is the other mode: you are not debugging, you want to make a video, and
 * three terminals is three chances to forget one.
 *
 * Started detached, with their output going to files rather than nowhere, so a
 * server that dies at 3am leaves an explanation behind.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { REPO, request, sleep } from "./lib.js";
import { EDITOR, UGC_FARM, UGC_FARM_DIR, UI_SNAP, UI_SNAP_DIR } from "./preflight.js";

export const LOGS = join(REPO, "storage/orchestrate/logs");

/** How each one starts, and how to tell it is awake. */
export function services() {
  const farmPython = resolve(UGC_FARM_DIR, ".venv/bin/python");
  return [
    {
      name: "ui-snap",
      url: UI_SNAP,
      cwd: UI_SNAP_DIR,
      command: "bun",
      args: ["dev"],
      // This probe launches Chrome on the other side, so it is slow and truthful:
      // a 200 saying available:false means the server is up but cannot shoot.
      ready: async () => {
        const answer = await request(`${UI_SNAP}/api/shot`, { timeoutMs: 20000 });
        return answer.data?.available === true;
      },
    },
    {
      name: "ugc-farm",
      url: UGC_FARM,
      cwd: UGC_FARM_DIR,
      command: existsSync(farmPython) ? farmPython : "python3",
      args: ["ugc.py", "serve"],
      ready: async () => (await request(`${UGC_FARM}/healthz`, { timeoutMs: 8000 })).data?.ok === true,
    },
    {
      name: "editor",
      url: EDITOR,
      cwd: resolve(REPO, "apps/editor"),
      command: "pnpm",
      args: ["--filter", "@openreel/web", "dev"],
      ready: async () => (await request(EDITOR, { timeoutMs: 8000 })).ok,
    },
  ];
}

const isUp = async (service) => {
  try {
    return await service.ready();
  } catch {
    return false;
  }
};

function launch(service) {
  mkdirSync(LOGS, { recursive: true });
  const logPath = join(LOGS, `${service.name}.log`);
  const log = openSync(logPath, "a");
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    detached: true,
    stdio: ["ignore", log, log],
  });
  // Let it outlive this process — the point is that it is still there for the
  // next prompt, and the one after that.
  child.unref();
  return { pid: child.pid, logPath };
}

/**
 * Bring everything up. Already-running servers are left exactly alone — this
 * never restarts something that is working.
 *
 * @param {(line: string) => void} log
 */
export async function startAll(log, { waitMs = 150000 } = {}) {
  const all = services();
  const started = [];

  for (const service of all) {
    if (await isUp(service)) {
      log(`  ${service.name.padEnd(9)} already running`);
      continue;
    }
    const { pid, logPath } = launch(service);
    started.push({ ...service, pid, logPath });
    log(`  ${service.name.padEnd(9)} starting (pid ${pid}) -> ${logPath.replace(REPO, ".")}`);
  }
  if (!started.length) return { ok: true, started };

  log("");
  const deadline = Date.now() + waitMs;
  const waiting = new Set(started.map((s) => s.name));
  while (waiting.size && Date.now() < deadline) {
    await sleep(2000);
    for (const service of started) {
      if (!waiting.has(service.name)) continue;
      if (await isUp(service)) {
        waiting.delete(service.name);
        log(`  ${service.name.padEnd(9)} up`);
      }
    }
  }

  if (waiting.size) {
    for (const name of waiting) {
      const service = started.find((s) => s.name === name);
      // The tail of its own log says more than any message this could invent.
      const tail = existsSync(service.logPath)
        ? readFileSync(service.logPath, "utf8").trim().split("\n").slice(-4).join("\n      ")
        : "(nothing logged)";
      log(`  ${name.padEnd(9)} did not come up. Last lines:\n      ${tail}`);
    }
    return { ok: false, started, stuck: [...waiting] };
  }
  return { ok: true, started };
}

/** Stop them, by what they are rather than by a pid file that can go stale. */
export function stopAll(log) {
  const patterns = [
    ["ui-snap", `bun.*dev`, UI_SNAP_DIR],
    ["ugc-farm", `ugc.py serve`, UGC_FARM_DIR],
    ["editor", `@openreel/web dev`, resolve(REPO, "apps/editor")],
  ];
  for (const [name, pattern] of patterns) {
    const child = spawn("pkill", ["-f", pattern], { stdio: "ignore" });
    child.on("close", (code) => log(`  ${name.padEnd(9)} ${code === 0 ? "stopped" : "was not running"}`));
  }
}
