/**
 * The saved-mask library, through its real HTTP routes, against a throwaway SQLite file.
 *
 * config.js reads its paths from the environment at import time, so the env is set before
 * anything is imported. Needs no Redis, no ffmpeg and no running server - Fastify's inject
 * drives the routes in-process.
 *
 * The tests that matter most are the copy-semantics ones: applying an entry must leave the
 * clip holding its own copy of the shape, so deleting the entry afterwards cannot change it.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";

let app;
let db;
let masks;
let applyOps;
let root;

const PORTRAIT = { width: 1080, height: 1920 };

/** A full-width square in a portrait frame: 1080px a side, centred. */
const PORTRAIT_SQUARE = {
  closed: true,
  points: [
    { x: 0, y: 420 / 1920 },
    { x: 1, y: 420 / 1920 },
    { x: 1, y: 1500 / 1920 },
    { x: 0, y: 1500 / 1920 },
  ],
};

const STAR_SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
<path d="M256 24L322.5 189.5L488 208.5L363 324.5L399.5 488L256 402.5L112.5 488L149 324.5L24 208.5L189.5 189.5L256 24Z"/>
</svg>`;

function project(id, { width = 1920, height = 1080, masksOnClip = [] } = {}) {
  return {
    id,
    name: id,
    settings: { width, height, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: {
      tracks: [{ id: "t1", name: "Video 1", clips: [{ id: "c1", startTime: 0, duration: 4 }] }],
      subtitles: [],
      duration: 4,
      markers: [],
    },
    masks: masksOnClip,
  };
}

async function post(body) {
  const response = await app.inject({ method: "POST", url: "/masks", payload: body });
  return { status: response.statusCode, body: response.json() };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saved-masks-test-"));
  process.env.DB_PATH = path.join(root, "test.sqlite");
  process.env.MEDIA_DIR = path.join(root, "media");
  process.env.RENDER_STORAGE_DIR = path.join(root, "rendered");
  process.env.EXPORT_DIR = path.join(root, "exports");

  const Fastify = (await import("fastify")).default;
  db = await import("../src/db.js");
  masks = await import("../src/routes-masks.js");
  ({ applyOps } = await import("../../../packages/project-kit/src/index.js"));

  app = Fastify();
  await masks.registerMaskRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  db.closeDb();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  db.getDb().exec("DELETE FROM saved_masks");
  db.getDb().exec("DELETE FROM projects");
});

/* ------------------------------------------------------------------ saving */

test("saves a path with the frame it was made in", async () => {
  const { status, body } = await post({ name: "Square", path: PORTRAIT_SQUARE, sourceWidth: 1080, sourceHeight: 1920 });

  assert.equal(status, 201);
  assert.equal(body.name, "Square");
  assert.equal(body.pointCount, 4);
  assert.equal(body.sourceWidth, 1080);
  assert.equal(body.sourceHeight, 1920);
});

test("saves an SVG, using its own viewBox as the source frame", async () => {
  const { status, body } = await post({ name: "Star", svg: STAR_SVG });

  assert.equal(status, 201);
  assert.equal(body.pointCount, 10);
  assert.equal(body.sourceWidth, 512);
  assert.equal(body.sourceHeight, 512);

  // The original markup is kept for provenance, and returned only on the full fetch.
  const full = (await app.inject({ url: `/masks/${body.id}` })).json();
  assert.equal(full.sourceSvg, STAR_SVG);
});

test("saves a clip's current mask in its project's frame", async () => {
  db.upsertProject({
    id: "p1",
    name: "p1",
    project: project("p1", {
      ...PORTRAIT,
      masksOnClip: [{ id: "m1", clipId: "c1", type: "drawn", path: PORTRAIT_SQUARE, keyframes: [] }],
    }),
  });

  const { status, body } = await post({ name: "From clip", projectId: "p1", clipId: "c1" });

  assert.equal(status, 201);
  assert.equal(body.sourceWidth, 1080);
  assert.equal(body.sourceHeight, 1920);
  assert.deepEqual(body.warnings, []);
});

test("asks which mask when a clip has several", async () => {
  db.upsertProject({
    id: "p1",
    name: "p1",
    project: project("p1", {
      masksOnClip: [
        { id: "m1", clipId: "c1", type: "drawn", path: PORTRAIT_SQUARE },
        { id: "m2", clipId: "c1", type: "shape", path: PORTRAIT_SQUARE },
      ],
    }),
  });

  const ambiguous = await post({ name: "Which", projectId: "p1", clipId: "c1" });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.code, "AMBIGUOUS_MASK");
  assert.match(ambiguous.body.error, /m1 \(drawn\).*m2 \(shape\)/);

  const chosen = await post({ name: "Which", projectId: "p1", clipId: "c1", maskId: "m2" });
  assert.equal(chosen.status, 201);
});

test("refuses to save a track matte, which has no shape of its own", async () => {
  db.upsertProject({
    id: "p1",
    name: "p1",
    project: project("p1", {
      masksOnClip: [{ id: "m1", clipId: "c1", type: "track-matte", path: PORTRAIT_SQUARE }],
    }),
  });

  const { status, body } = await post({ name: "Matte", projectId: "p1", clipId: "c1" });
  assert.equal(status, 400);
  assert.equal(body.code, "UNSAVABLE_MASK");
});

test("saves only the current shape of an animated mask, and says so", async () => {
  db.upsertProject({
    id: "p1",
    name: "p1",
    project: project("p1", {
      masksOnClip: [
        { id: "m1", clipId: "c1", type: "drawn", path: PORTRAIT_SQUARE, keyframes: [{ id: "k", time: 1 }] },
      ],
    }),
  });

  const { status, body } = await post({ name: "Animated", projectId: "p1", clipId: "c1" });
  assert.equal(status, 201);
  assert.match(body.warnings[0], /only its current shape/);
});

test("names are unique regardless of case", async () => {
  await post({ name: "Logo", svg: STAR_SVG });
  const clash = await post({ name: "  logo ", svg: STAR_SVG });

  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "NAME_TAKEN");
});

test("rejects a request with no source, or with two", async () => {
  assert.equal((await post({ name: "None" })).status, 400);
  const both = await post({ name: "Both", svg: STAR_SVG, path: PORTRAIT_SQUARE, sourceWidth: 1, sourceHeight: 1 });
  assert.equal(both.status, 400);
});

test("rejects a path without its source frame", async () => {
  const { status, body } = await post({ name: "No frame", path: PORTRAIT_SQUARE });
  assert.equal(status, 400);
  assert.match(body.error, /sourceWidth and sourceHeight/);
});

test("rejects a multi-path SVG with the parser's count", async () => {
  const { status, body } = await post({
    name: "Multi",
    svg: '<svg viewBox="0 0 10 10"><path d="M0 0L1 0L1 1Z"/><path d="M2 2L3 2L3 3Z"/></svg>',
  });
  assert.equal(status, 400);
  assert.equal(body.code, "INVALID_SVG");
  assert.match(body.error, /2 paths/);
});

/* ------------------------------------------------------- listing and delete */

test("lists entries with a thumbnail outline but no heavy data", async () => {
  await post({ name: "Star", svg: STAR_SVG });

  const { masks: listed } = (await app.inject({ url: "/masks" })).json();

  assert.equal(listed.length, 1);
  assert.match(listed[0].previewPath, /^M256 24L/);
  assert.equal(listed[0].sourceSvg, undefined);
  assert.equal(listed[0].path, undefined);
});

test("deletes an entry, and 404s on a second delete", async () => {
  const { body } = await post({ name: "Star", svg: STAR_SVG });

  assert.equal((await app.inject({ method: "DELETE", url: `/masks/${body.id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/masks/${body.id}` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/masks/${body.id}` })).statusCode, 404);
});

/* ------------------------------------------------------- applying via ops */

test("resolves a saved mask by name into re-fitted points", async () => {
  await post({ name: "Square", path: PORTRAIT_SQUARE, sourceWidth: 1080, sourceHeight: 1920 });
  const target = project("landscape", { width: 1920, height: 1080 });

  const [resolved] = masks.resolveSavedMaskRefs(
    [{ op: "set_clip_mask", clipId: "c1", savedMaskName: "square" }],
    target,
  );

  assert.equal(resolved.savedMaskName, undefined);
  // Measured in the target's pixels, the square is still square.
  const xs = resolved.points.map((p) => p.x * 1920);
  const ys = resolved.points.map((p) => p.y * 1080);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(width - height) < 1e-6, `expected a square, got ${width}x${height}`);
});

test("names what exists when a saved mask is not found", () => {
  assert.throws(
    () => masks.resolveSavedMaskRefs([{ op: "set_clip_mask", clipId: "c1", savedMaskName: "Nope" }], project("p")),
    (error) => error.code === "SAVED_MASK_NOT_FOUND" && /Saved masks: none/.test(error.message),
  );
});

test("refuses a saved mask alongside svg or points", async () => {
  await post({ name: "Star", svg: STAR_SVG });
  assert.throws(
    () =>
      masks.resolveSavedMaskRefs(
        [{ op: "set_clip_mask", clipId: "c1", savedMaskName: "Star", svg: STAR_SVG }],
        project("p"),
      ),
    (error) => error.code === "INVALID_PARAMS",
  );
});

test("leaves other ops untouched", () => {
  const ops = [{ op: "add_track", name: "x" }, { op: "set_clip_mask", clipId: "c1", svg: STAR_SVG }];
  assert.deepEqual(masks.resolveSavedMaskRefs(ops, project("p")), ops);
});

test("applying copies the shape: deleting the entry leaves the clip's mask intact", async () => {
  const { body } = await post({ name: "Star", svg: STAR_SVG });
  const target = project("p1", { width: 1920, height: 1080 });

  const resolved = masks.resolveSavedMaskRefs(
    [{ op: "set_clip_mask", clipId: "c1", savedMaskId: body.id }],
    target,
  );
  const applied = applyOps(target, resolved).project;
  const before = JSON.stringify(applied.masks);

  // The clip's mask carries its own full path and no pointer back to the library.
  assert.equal(applied.masks[0].path.points.length, 10);
  assert.ok(!JSON.stringify(applied.masks).includes(body.id), "the clip must not reference the entry");

  await app.inject({ method: "DELETE", url: `/masks/${body.id}` });

  assert.equal(JSON.stringify(applied.masks), before);
});

test("lists same-millisecond saves newest first, deterministically", async () => {
  const ids = [];
  for (const name of ["A", "B", "C", "D"]) {
    ids.push((await post({ name, svg: STAR_SVG })).body.id);
  }
  db.getDb().exec("UPDATE saved_masks SET created_at = 1700000000000");

  const { masks: listed } = (await app.inject({ url: "/masks" })).json();
  assert.deepEqual(listed.map((m) => m.id), [...ids].reverse());
});
