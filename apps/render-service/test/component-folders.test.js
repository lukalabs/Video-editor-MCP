/**
 * Component folders, through the real routes, against a throwaway copy of the catalogue.
 *
 * COMPONENT_LIBRARY_DIR points the service at the copy, so no tracked meta.json is ever
 * written by a test. The properties that matter because these files are tracked: a re-file
 * is exactly one added line, clearing restores the original bytes, and concurrent re-files
 * never leave a reader looking at a half-written file.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_COMPONENTS = path.resolve(HERE, "..", "..", "..", "packages", "component-library", "components");

let app;
let root;
let componentsDir;

/**
 * A real meta.json as it would be with no folder. The copy starts unfiled so these tests
 * do not depend on how the real catalogue happens to be organised today; valid because
 * every real file round-trips byte for byte (the first test guards that).
 */
function unfiled(raw) {
  const { folder: _folder, ...rest } = JSON.parse(raw);
  return JSON.stringify(rest, null, 2) + "\n";
}

async function copyCatalogue() {
  await fs.rm(componentsDir, { recursive: true, force: true });
  for (const entry of await fs.readdir(REAL_COMPONENTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await fs.mkdir(path.join(componentsDir, entry.name), { recursive: true });
    const raw = await fs.readFile(path.join(REAL_COMPONENTS, entry.name, "meta.json"), "utf8");
    await fs.writeFile(path.join(componentsDir, entry.name, "meta.json"), unfiled(raw));
  }
}

const metaPath = (id) => path.join(componentsDir, id, "meta.json");
const read = (id) => fs.readFile(metaPath(id), "utf8");
/** The unfiled starting bytes of a component's copy. */
const original = async (id) => unfiled(await fs.readFile(path.join(REAL_COMPONENTS, id, "meta.json"), "utf8"));

async function patch(id, body) {
  const response = await app.inject({ method: "PATCH", url: `/components/${id}/folder`, payload: body });
  return { status: response.statusCode, body: response.json() };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "component-folders-test-"));
  process.env.COMPONENT_LIBRARY_DIR = root;
  process.env.DB_PATH = path.join(root, "test.sqlite");
  componentsDir = path.join(root, "components");
  const Fastify = (await import("fastify")).default;
  const { registerComponentRoutes } = await import("../src/routes-components.js");
  app = Fastify();
  await registerComponentRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  (await import("../src/db.js")).closeDb();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(copyCatalogue);

test("every real meta.json round-trips byte for byte, so a re-file can only ever be one line", async () => {
  // A hand-formatted file (stat-counter's was) would be reformatted wholesale on its first
  // re-file. Normalise it with JSON.stringify(_, null, 2) plus a newline if this ever fails.
  for (const id of await fs.readdir(REAL_COMPONENTS)) {
    const raw = await fs.readFile(path.join(REAL_COMPONENTS, id, "meta.json"), "utf8").catch(() => null);
    if (raw === null) continue;
    assert.equal(JSON.stringify(JSON.parse(raw), null, 2) + "\n", raw, `${id}/meta.json is not in canonical form`);
  }
});

test("re-filing adds exactly one line, right after description", async () => {
  const before = (await read("button-shimmer")).split("\n");
  const { status, body } = await patch("button-shimmer", { folder: "Buttons" });

  assert.equal(status, 200);
  assert.deepEqual(body, { id: "button-shimmer", folder: "Buttons" });
  const after = (await read("button-shimmer")).split("\n");
  assert.equal(after.length, before.length + 1);
  const at = before.findIndex((line) => line.startsWith('  "description":')) + 1;
  assert.equal(after[at], '  "folder": "Buttons",');
  assert.deepEqual([...after.slice(0, at), ...after.slice(at + 1)], before);
});

test("clearing restores the original bytes exactly", async () => {
  await patch("stat-counter", { folder: "Text" });
  await patch("stat-counter", { folder: "" });
  assert.equal(await read("stat-counter"), await original("stat-counter"));

  await patch("orbit-headline-Rep", { folder: "Text" });
  await patch("orbit-headline-Rep", { folder: " Uncategorized " });
  assert.equal(await read("orbit-headline-Rep"), await original("orbit-headline-Rep"));
});

test("moving between folders changes only the folder line", async () => {
  await patch("button", { folder: "Buttons" });
  const before = (await read("button")).split("\n");
  await patch("button", { folder: "  Legacy  " });
  const after = (await read("button")).split("\n");

  assert.equal(after.length, before.length);
  const changed = after.map((line, i) => (line === before[i] ? null : i)).filter((i) => i !== null);
  assert.equal(changed.length, 1);
  assert.equal(after[changed[0]], '  "folder": "Legacy",');
});

test("refuses bad requests without touching the file", async () => {
  const untouched = await read("button-shimmer");
  assert.equal((await patch("no-such-component", { folder: "X" })).status, 404);
  assert.equal((await patch("button-shimmer", { folder: 42 })).status, 400);
  assert.equal((await patch("button-shimmer", {})).status, 400);
  assert.equal((await patch("button-shimmer", { folder: "x".repeat(81) })).status, 400);
  assert.equal((await patch("..%2F..%2Fpackage", { folder: "X" })).status, 404);
  assert.equal(await read("button-shimmer"), untouched);
});

test("the catalogue reports folders, the default for unfiled ones, and filters by folder", async () => {
  await patch("chat-thread-Rep", { folder: "Chat" });
  await patch("chat-bubble-single-Rep", { folder: "Chat" });

  const all = (await app.inject({ url: "/components" })).json().components;
  assert.equal(all.find((c) => c.id === "chat-thread-Rep").folder, "Chat");
  assert.equal(all.find((c) => c.id === "button").folder, "Uncategorized");

  const chat = (await app.inject({ url: "/components?folder=Chat" })).json().components;
  assert.deepEqual(chat.map((c) => c.id).sort(), ["chat-bubble-single-Rep", "chat-thread-Rep"]);

  const unfiled = (await app.inject({ url: "/components?folder=Uncategorized" })).json().components;
  assert.equal(unfiled.length, all.length - 2);

  const { folders } = (await app.inject({ url: "/components/folders" })).json();
  assert.deepEqual(folders, ["Chat", "Uncategorized"]);
});

test("20 concurrent re-files: all succeed, the last one wins, readers never see a partial file", async () => {
  const id = "button-pulse-glow";
  let reading = true;
  let reads = 0;
  const reader = (async () => {
    while (reading) {
      JSON.parse(await read(id)); // throws on a half-written file
      reads += 1;
    }
  })();

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => patch(id, { folder: `Folder ${i}` })),
  );
  reading = false;
  await reader;

  const failed = results.map((r, i) => ({ i, ...r })).filter((r) => r.status !== 200);
  assert.deepEqual(failed, [], "every re-file should succeed");
  // Writes are serialised in arrival order, so the last request is the final state.
  assert.equal(JSON.parse(await read(id)).folder, "Folder 19");
  const leftovers = (await fs.readdir(path.dirname(metaPath(id)))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp files may be left behind");
  // Still exactly one line different from the committed file.
  assert.equal((await read(id)).split("\n").length, (await original(id)).split("\n").length + 1);
  assert.ok(reads > 0, "the reader should have run during the writes");
});

test("a CRLF file stays CRLF", async () => {
  const id = "button-bounce-in";
  const crlf = (await read(id)).replace(/\n/g, "\r\n");
  await fs.writeFile(metaPath(id), crlf);
  await patch(id, { folder: "Buttons" });
  const text = await read(id);
  assert.ok(!/[^\r]\n/.test(text), "every newline should still be CRLF");
  await patch(id, { folder: "" });
  assert.equal(await read(id), crlf);
});
