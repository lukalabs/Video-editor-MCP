import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getComponent, listComponents } from "./components.js";
import { componentsDir } from "./config.js";
import { DEFAULT_PROJECT_FOLDER, normaliseFolder } from "./db.js";

/**
 * Folders for the component catalogue: a `folder` field in each component's meta.json.
 *
 * Deliberately stored in the tracked meta.json rather than in the database: a component's
 * folder is catalogue organisation, so it travels with the component to every checkout. The
 * cost is that re-filing changes a tracked file, so writes here are careful to change
 * exactly one line - the key goes right after `description`, and clearing it deletes the key
 * so the file returns to the bytes it had before (every meta.json round-trips byte for byte
 * through JSON.stringify(_, null, 2)).
 *
 * Same vocabulary as project folders (Stage 22): free text, trimmed, and an empty string or
 * the default name means "no folder". A component with no folder reports the default in
 * API responses; the default is never written to disk.
 */
export const DEFAULT_COMPONENT_FOLDER = DEFAULT_PROJECT_FOLDER;

const MAX_FOLDER_LENGTH = 80;
/**
 * Windows briefly refuses to rename over a file something else is holding - antivirus
 * scanning a freshly written file, or a handle from a moment ago - and reports EPERM, EACCES
 * or EBUSY. It clears on its own, usually within milliseconds but not always: a budget of six
 * attempts (~1.2s) still failed 1 time in 8 under a stress test. npm hit exactly this, which
 * is why graceful-fs retries these renames on Windows for up to 60s; this retries for up to
 * 10s in short steps, which is plenty for a metadata file.
 */
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_BUDGET_MS = 10_000;

export class ComponentFolderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** How a component is reported: its stored folder, or the default when it has none. */
export function withFolder(meta) {
  return { ...meta, folder: meta.folder ?? DEFAULT_COMPONENT_FOLDER };
}

/** The distinct folders in use, sorted, the default included when anything is unfiled. */
export async function listComponentFolders() {
  const components = await listComponents();
  const names = new Set(components.map((meta) => meta.folder ?? DEFAULT_COMPONENT_FOLDER));
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Rebuilds the meta object with `folder` right after `description` (or removed), keeping
 * every other key where it was - so the serialised file differs by exactly that line.
 */
function placeFolder(meta, folder) {
  const out = {};
  let placed = folder === null;
  for (const [key, value] of Object.entries(meta)) {
    if (key === "folder") continue;
    out[key] = value;
    if (key === "description" && !placed) {
      out.folder = folder;
      placed = true;
    }
  }
  if (!placed) out.folder = folder;
  return out;
}

/** Writes a file so that readers only ever see the old bytes or the new ones, never half. */
async function writeAtomically(target, text) {
  const temp = path.join(path.dirname(target), `.meta.json.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.rename(temp, target);
        return;
      } catch (error) {
        if (!RETRYABLE.has(error.code) || Date.now() - started > RENAME_BUDGET_MS) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * attempt)));
      }
    }
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * One write at a time per component, in arrival order. Each re-file is a read-modify-write
 * of the whole file; two interleaved ones could each start from the same bytes and the later
 * rename would drop whatever the earlier one changed.
 *
 * A request joins its component's queue synchronously, the moment it arrives - anything
 * awaited first (the catalogue lookup was) lets later requests overtake it, and then "Move
 * to A, then B" could end in A while the second response said B. The stress test caught
 * exactly that: 20 concurrent re-files finished on the 15th, not the 20th.
 */
const queues = new Map();
function serialised(id, task) {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => {});
  queues.set(id, tail);
  // Forget an idle component, so ids from bad requests do not accumulate.
  tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return next;
}

/**
 * Files a component under `folder`; an empty string or the default name clears it.
 * Returns the folder the component now reports.
 */
export async function setComponentFolder(id, folder) {
  if (typeof folder !== "string") {
    throw new ComponentFolderError(400, "folder must be a string (an empty string clears it)");
  }
  if (folder.trim().length > MAX_FOLDER_LENGTH) {
    throw new ComponentFolderError(400, `folder must be at most ${MAX_FOLDER_LENGTH} characters`);
  }
  if (typeof id !== "string") throw new ComponentFolderError(404, "Unknown component");
  const stored = normaliseFolder(folder);

  // Queued before anything is awaited: see serialised().
  return serialised(id, async () => {
    // Only ids the catalogue knows reach the filesystem, which also rules out path tricks.
    if (!(await getComponent(id))) {
      throw new ComponentFolderError(404, `Unknown component "${id}"`);
    }
    const target = path.join(componentsDir, id, "meta.json");
    const raw = await fs.readFile(target, "utf8");
    const crlf = raw.includes("\r\n");
    const meta = JSON.parse(raw);
    let text = JSON.stringify(placeFolder(meta, stored), null, 2) + "\n";
    if (crlf) text = text.replace(/\n/g, "\r\n");
    if (text !== raw) await writeAtomically(target, text);
    return { id, folder: stored ?? DEFAULT_COMPONENT_FOLDER };
  });
}
