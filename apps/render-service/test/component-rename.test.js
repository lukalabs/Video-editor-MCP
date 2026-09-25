/**
 * Moving stored references to a renamed component id, against a throwaway SQLite file.
 *
 * The case that matters most is the placed clip: updating component_metadata alone looks
 * like a fix and is not one, because the editor never re-stamps a clip that already
 * carries component metadata - the panel reads the clip's own componentId.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";

let db;
let rename;
let root;

const OLD = "button-shimmer-Rep";
const NEW = "button-shimmer";

function project(id, componentId) {
  return {
    id,
    name: id,
    settings: { width: 1080, height: 1920, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [{ id: "m1", name: `${componentId}-Get Started.webm` }] },
    timeline: {
      tracks: [{
        id: "t1",
        clips: [
          { id: "c1", mediaId: "m1", metadata: { source: "component-library", componentId, props: { text: "Hi" } } },
          // Not a component clip: its metadata must be left exactly as it is.
          { id: "c2", mediaId: "m2", metadata: { source: "something-else", componentId } },
        ],
      }],
      subtitles: [],
      duration: 4,
      markers: [],
    },
  };
}

function stored(id) {
  return db.getProject(id).project;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "component-rename-test-"));
  process.env.DB_PATH = path.join(root, "test.sqlite");
  process.env.MEDIA_DIR = path.join(root, "media");
  process.env.RENDER_STORAGE_DIR = path.join(root, "rendered");
  process.env.EXPORT_DIR = path.join(root, "exports");
  db = await import("../src/db.js");
  rename = await import("../src/component-rename.js");
});

after(async () => {
  db.closeDb();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  const handle = db.getDb();
  for (const table of ["component_metadata", "project_versions", "projects"]) handle.exec(`DELETE FROM ${table}`);
  db.upsertProject({ id: "p1", name: "Test btns", project: project("p1", OLD) });
  db.upsertComponentMetadata({ mediaId: "m1", componentId: OLD, props: { text: "Hi" }, background: null, renderedFileId: null });
  db.createProjectVersion({ projectId: "p1", project: project("p1", OLD), origin: "auto" });
});

test("moves component_metadata, placed clips and version snapshots to the new id", () => {
  const report = rename.renameComponentIds(db.getDb(), { [OLD]: NEW });

  assert.equal(db.getComponentMetadata("m1").componentId, NEW);
  assert.equal(stored("p1").timeline.tracks[0].clips[0].metadata.componentId, NEW);
  const [version] = db.listProjectVersions("p1");
  assert.equal(db.getProjectVersion(version.id).project.timeline.tracks[0].clips[0].metadata.componentId, NEW);
  assert.deepEqual(
    { rows: report.componentMetadata, projects: report.projects.length, clips: report.clips, versions: report.versions },
    { rows: 1, projects: 1, clips: 1, versions: 1 },
  );
});

test("leaves labels and non-component clips alone", () => {
  rename.renameComponentIds(db.getDb(), { [OLD]: NEW });
  const p = stored("p1");

  assert.equal(p.mediaLibrary.items[0].name, `${OLD}-Get Started.webm`);
  assert.equal(p.timeline.tracks[0].clips[1].metadata.componentId, OLD);
  assert.deepEqual(p.timeline.tracks[0].clips[0].metadata.props, { text: "Hi" });
});

test("bumps updated_at on a changed project, so a stale open copy conflicts instead of overwriting", () => {
  const before = db.getProjectUpdatedAt("p1");
  rename.renameComponentIds(db.getDb(), { [OLD]: NEW }, { now: before + 1000 });
  assert.equal(db.getProjectUpdatedAt("p1"), before + 1000);
});

test("is idempotent: a second run changes nothing", () => {
  rename.renameComponentIds(db.getDb(), { [OLD]: NEW });
  const again = rename.renameComponentIds(db.getDb(), { [OLD]: NEW });

  assert.deepEqual(
    { rows: again.componentMetadata, projects: again.projects.length, versions: again.versions },
    { rows: 0, projects: 0, versions: 0 },
  );
});

test("a dry run reports what it would change and writes nothing", () => {
  const report = rename.renameComponentIds(db.getDb(), { [OLD]: NEW }, { dryRun: true });

  assert.equal(report.componentMetadata, 1);
  assert.equal(report.clips, 1);
  assert.equal(db.getComponentMetadata("m1").componentId, OLD);
  assert.equal(stored("p1").timeline.tracks[0].clips[0].metadata.componentId, OLD);
});

test("the Stage 33 preset maps all ten buttons and nothing else", () => {
  const preset = rename.RENAME_PRESETS["cta-drop-rep"];
  assert.equal(Object.keys(preset).length, 10);
  for (const [from, to] of Object.entries(preset)) {
    assert.match(from, /^button-[a-z0-9-]+-Rep$/);
    assert.equal(to, from.replace(/-Rep$/, ""));
  }
});
