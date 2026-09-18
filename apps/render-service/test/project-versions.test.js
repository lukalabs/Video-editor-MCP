/**
 * Version history at the storage layer, against a throwaway SQLite file.
 *
 * config.js reads its paths from the environment at import time, so the env is set before
 * anything is imported and nothing here can touch the real storage/ tree. Needs no Redis,
 * no ffmpeg and no server.
 *
 * The test that matters most is the sweep one: a version nobody can restore because its
 * footage was collected is not a version, and the clip someone deleted this morning is
 * exactly the media a naive sweep would take - right before they reach for the history.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";

let db;
let sweep;
let root;

function project(id, name, { mediaIds = [], duration = 0 } = {}) {
  return {
    id,
    name,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: mediaIds.map((mediaId) => ({ id: mediaId, name: `${mediaId}.mp4` })) },
    timeline: {
      tracks: [
        {
          id: "t1",
          clips: mediaIds.map((mediaId, index) => ({ id: `c${index}`, mediaId })),
        },
      ],
      subtitles: [],
      duration,
      markers: [],
    },
  };
}


/** Ages one version, so ordering and the floors are explicit rather than incidental. */
function setCreatedAt(versionId, createdAt) {
  db.getDb()
    .prepare("UPDATE project_versions SET created_at = ? WHERE id = ?")
    .run(createdAt, versionId);
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "versions-test-"));
  process.env.DB_PATH = path.join(root, "test.sqlite");
  process.env.MEDIA_DIR = path.join(root, "media");
  process.env.RENDER_STORAGE_DIR = path.join(root, "rendered");
  process.env.EXPORT_DIR = path.join(root, "exports");
  await fs.mkdir(process.env.MEDIA_DIR, { recursive: true });
  await fs.mkdir(process.env.RENDER_STORAGE_DIR, { recursive: true });
  await fs.mkdir(process.env.EXPORT_DIR, { recursive: true });
  db = await import("../src/db.js");
  sweep = await import("../src/sweep.js");
});

after(async () => {
  db.closeDb();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  const handle = db.getDb();
  handle.exec("DELETE FROM project_versions");
  handle.exec("DELETE FROM projects");
  handle.exec("DELETE FROM media");
});

test("stores a snapshot with metadata a human can choose from", () => {
  db.upsertProject({ id: "p1", name: "Demo", project: project("p1", "Demo", { duration: 12.5 }) });

  const version = db.createProjectVersion({
    projectId: "p1",
    project: project("p1", "Demo", { mediaIds: ["m1", "m2"], duration: 12.5 }),
    origin: "manual",
  });

  assert.equal(version.projectId, "p1");
  assert.equal(version.origin, "manual");
  assert.equal(version.clipCount, 2);
  assert.equal(version.duration, 12.5);
  assert.ok(version.sizeBytes > 0);
  assert.ok(version.createdAt > 0);
});

test("lists versions newest first and returns the full blob on demand", () => {
  db.upsertProject({ id: "p1", name: "Demo", project: project("p1", "Demo") });
  const first = db.createProjectVersion({
    projectId: "p1",
    project: project("p1", "First"),
    origin: "auto",
  });
  const second = db.createProjectVersion({
    projectId: "p1",
    project: project("p1", "Second"),
    origin: "manual",
  });

  const listed = db.listProjectVersions("p1");
  assert.deepEqual(
    listed.map((v) => v.id),
    [second.id, first.id],
  );
  // The list carries no blobs; fetching one by id does.
  assert.equal(listed[0].project, undefined);
  assert.equal(db.getProjectVersion(first.id).project.name, "First");
});

test("keeps each project's history to itself", () => {
  db.upsertProject({ id: "p1", name: "One", project: project("p1", "One") });
  db.upsertProject({ id: "p2", name: "Two", project: project("p2", "Two") });
  db.createProjectVersion({ projectId: "p1", project: project("p1", "One"), origin: "auto" });
  db.createProjectVersion({ projectId: "p2", project: project("p2", "Two"), origin: "auto" });

  assert.equal(db.listProjectVersions("p1").length, 1);
  assert.equal(db.listProjectVersions("p2").length, 1);
});

test("deleting a project takes its versions with it", () => {
  db.upsertProject({ id: "p1", name: "Demo", project: project("p1", "Demo") });
  db.createProjectVersion({ projectId: "p1", project: project("p1", "Demo"), origin: "manual" });
  db.createProjectVersion({ projectId: "p1", project: project("p1", "Demo"), origin: "auto" });
  assert.equal(db.listProjectVersions("p1").length, 2);

  assert.equal(db.deleteProject("p1"), true);

  // The delete dialog promises this cannot be undone; restorable history would make
  // that a lie.
  assert.equal(db.listProjectVersions("p1").length, 0);
});

test("media referenced ONLY by an old version survives the sweep", async () => {
  // The scenario: footage was used this morning, removed from the timeline since. The
  // current project no longer mentions it; the version someone would restore does.
  db.insertMedia({
    id: "m-old",
    filename: "old.mp4",
    storagePath: path.join(process.env.MEDIA_DIR, "m-old.mp4"),
    mimeType: "video/mp4",
    size: 10,
  });
  await fs.writeFile(path.join(process.env.MEDIA_DIR, "m-old.mp4"), "x");

  db.createProjectVersion({
    projectId: "p1",
    project: project("p1", "This morning", { mediaIds: ["m-old"] }),
    origin: "auto",
  });
  db.upsertProject({
    id: "p1",
    name: "Now",
    project: project("p1", "Now", { mediaIds: [] }),
  });

  const removed = await sweep.sweepOrphanedMedia();

  assert.deepEqual(removed, [], "media held by a restorable version must not be swept");
  assert.ok(db.getMedia("m-old"), "the media row must still be there");
  assert.equal(db.findOrphanedMedia().length, 0);
});

test("media referenced by nothing at all is still swept", async () => {
  db.insertMedia({
    id: "m-loose",
    filename: "loose.mp4",
    storagePath: path.join(process.env.MEDIA_DIR, "m-loose.mp4"),
    mimeType: "video/mp4",
    size: 10,
  });
  await fs.writeFile(path.join(process.env.MEDIA_DIR, "m-loose.mp4"), "x");
  db.upsertProject({ id: "p1", name: "Now", project: project("p1", "Now") });

  const removed = await sweep.sweepOrphanedMedia();

  assert.deepEqual(removed, ["m-loose"]);
});

test("retention keeps the newest N per project", () => {
  db.upsertProject({ id: "p1", name: "Demo", project: project("p1", "Demo") });
  const ids = [];
  for (let i = 0; i < 35; i++) {
    ids.push(db.createProjectVersion({
      projectId: "p1",
      project: project("p1", `v${i}`),
      origin: "auto",
    }).id);
  }
  // Age every version past the 7-day floor so only the count rule applies.
  const old = Date.now() - 30 * 24 * 3_600_000;
  db.getDb().exec(`UPDATE project_versions SET created_at = created_at - ${30 * 24 * 3_600_000}`);

  const result = sweep.sweepProjectVersions({ keep: 30 });

  assert.equal(result.removed.length, 5);
  assert.equal(db.listProjectVersions("p1").length, 30);
  assert.ok(old > 0);
});

test("retention keeps anything younger than the age floor even past the count", () => {
  db.upsertProject({ id: "p1", name: "Demo", project: project("p1", "Demo") });
  for (let i = 0; i < 35; i++) {
    db.createProjectVersion({ projectId: "p1", project: project("p1", `v${i}`), origin: "auto" });
  }

  // All fresh: the count rule alone must not delete recent history.
  const result = sweep.sweepProjectVersions({ keep: 30 });

  assert.deepEqual(result.removed, []);
  assert.equal(db.listProjectVersions("p1").length, 35);
});

test("a manual version outlives an automatic one of the same age", () => {
  db.upsertProject({ id: "p1", name: "Demo", project: project("p1", "Demo") });

  // Six recent versions fill the keep window, so the two old ones below are judged by
  // the age floors rather than by the count.
  for (let i = 0; i < 6; i++) {
    const padding = db.createProjectVersion({
      projectId: "p1",
      project: project("p1", `pad${i}`),
      origin: "auto",
    });
    setCreatedAt(padding.id, Date.now() - 3_600_000);
  }
  const auto = db.createProjectVersion({
    projectId: "p1",
    project: project("p1", "auto"),
    origin: "auto",
  });
  const manual = db.createProjectVersion({
    projectId: "p1",
    project: project("p1", "manual"),
    origin: "manual",
  });
  // Both ten days old: past the 7-day automatic floor, inside the 30-day manual one.
  const tenDaysAgo = Date.now() - 10 * 24 * 3_600_000;
  setCreatedAt(auto.id, tenDaysAgo);
  setCreatedAt(manual.id, tenDaysAgo);

  sweep.sweepProjectVersions({ keep: 5 });

  const surviving = db.listProjectVersions("p1").map((v) => v.id);
  assert.ok(!surviving.includes(auto.id), "the automatic one should have been pruned");
  assert.ok(surviving.includes(manual.id), "a deliberate save should outlive the clock");
});

test("retention prunes each project independently", () => {
  db.upsertProject({ id: "busy", name: "Busy", project: project("busy", "Busy") });
  db.upsertProject({ id: "quiet", name: "Quiet", project: project("quiet", "Quiet") });
  for (let i = 0; i < 40; i++) {
    db.createProjectVersion({ projectId: "busy", project: project("busy", `v${i}`), origin: "auto" });
  }
  db.createProjectVersion({ projectId: "quiet", project: project("quiet", "only"), origin: "auto" });
  db.getDb().exec(
    `UPDATE project_versions SET created_at = created_at - ${30 * 24 * 3_600_000}`,
  );

  sweep.sweepProjectVersions({ keep: 30 });

  assert.equal(db.listProjectVersions("busy").length, 30);
  // A busy project must not evict a quiet one's entire history.
  assert.equal(db.listProjectVersions("quiet").length, 1);
});

test("a dry run reports what it would prune without pruning it", () => {
  db.upsertProject({ id: "p1", name: "Demo", project: project("p1", "Demo") });
  for (let i = 0; i < 35; i++) {
    db.createProjectVersion({ projectId: "p1", project: project("p1", `v${i}`), origin: "auto" });
  }
  db.getDb().exec(
    `UPDATE project_versions SET created_at = created_at - ${30 * 24 * 3_600_000}`,
  );

  const result = sweep.sweepProjectVersions({ keep: 30, dryRun: true });

  assert.equal(result.removed.length, 5);
  assert.equal(db.listProjectVersions("p1").length, 35);
});
