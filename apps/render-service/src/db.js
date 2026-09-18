import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { config } from "./config.js";

/**
 * Server-side storage for projects, media files and component metadata.
 *
 * SQLite via `node:sqlite` (Node core, no dependency, no native build). The schema is
 * deliberately thin: a project is stored as a JSON blob rather than a normalised
 * timeline, because the editor already has a stable serialisation format and this stage
 * is about making it available across browsers, not about querying inside it.
 *
 * Swapping to Postgres later means replacing this module: the queries are plain SQL and
 * the exported functions are the only surface the routes use.
 */

let db = null;

export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media (
      id            TEXT PRIMARY KEY,
      filename      TEXT NOT NULL,
      storage_path  TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS component_metadata (
      media_id         TEXT PRIMARY KEY,
      component_id     TEXT NOT NULL,
      props            TEXT NOT NULL,
      background       TEXT,
      rendered_file_id TEXT,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_versions (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      data        TEXT NOT NULL,
      origin      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      size_bytes  INTEGER NOT NULL,
      clip_count  INTEGER,
      duration    REAL,
      label       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_versions_project
      ON project_versions(project_id, created_at DESC);
  `);

  // Added after the table shipped, so tolerate an existing column.
  try {
    db.exec("ALTER TABLE media ADD COLUMN metadata TEXT");
  } catch {
    // already present
  }
  // The editor's MediaItem.type ("video" | "audio" | "image"). Kept out of the metadata
  // blob because that blob is handed to the editor verbatim as MediaMetadata.
  try {
    db.exec("ALTER TABLE media ADD COLUMN media_type TEXT");
  } catch {
    // already present
  }
  // Free-text organisation, one folder per project. Deliberately nullable with no
  // backfill: NULL means "never categorised" and is presented as DEFAULT_PROJECT_FOLDER,
  // which keeps it distinguishable from a project someone deliberately filed under a
  // folder of that name. Kept as a column rather than inside the project JSON because it
  // describes the stored record, not the composition — see NOTES.md Stage 22.
  try {
    db.exec("ALTER TABLE projects ADD COLUMN folder TEXT");
  } catch {
    // already present
  }

  return db;
}

/** What a project with no folder reports as. Never written to the column. */
export const DEFAULT_PROJECT_FOLDER = "Uncategorized";

/* ---------------------------------------------------------------- projects */

/**
 * Saved projects, newest first. `folder` filters to one folder; asking for the default
 * folder also returns the rows that have never been categorised, since those are the same
 * thing as far as a caller is concerned.
 */
export function listProjects({ folder } = {}) {
  const base =
    "SELECT id, name, folder, created_at, updated_at FROM projects";
  const order = " ORDER BY updated_at DESC";

  let rows;
  if (folder === undefined || folder === null) {
    rows = getDb().prepare(base + order).all();
  } else if (folder === DEFAULT_PROJECT_FOLDER) {
    rows = getDb()
      .prepare(`${base} WHERE folder IS NULL OR folder = ?${order}`)
      .all(folder);
  } else {
    rows = getDb().prepare(`${base} WHERE folder = ?${order}`).all(folder);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    folder: row.folder ?? DEFAULT_PROJECT_FOLDER,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** The distinct folders in use, so a picker does not have to list every project. */
export function listProjectFolders() {
  const rows = getDb()
    .prepare("SELECT DISTINCT folder FROM projects ORDER BY folder")
    .all();
  const names = new Set(
    rows.map((row) => row.folder ?? DEFAULT_PROJECT_FOLDER),
  );
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function getProject(id) {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    folder: row.folder ?? DEFAULT_PROJECT_FOLDER,
    project: JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert or update a project.
 *
 * `folder` is only written when the caller passes one: `COALESCE(excluded.folder, …)`
 * means an ordinary save — which carries the project JSON but knows nothing about
 * folders — cannot null out a folder someone set. Pass an empty string to clear it back
 * to the default.
 */
export function upsertProject({ id, name, project, folder }) {
  const now = Date.now();
  const data = JSON.stringify(project);
  const setsFolder = folder !== undefined;
  const folderValue = setsFolder ? normaliseFolder(folder) : null;

  // Two statements rather than one with COALESCE: "no folder given" and "clear the folder"
  // both reduce to SQL NULL, so a single statement cannot tell them apart — COALESCE made
  // the explicit clear silently do nothing. They differ only in whether DO UPDATE touches
  // the folder column; both take the same six parameters.
  const SET_FOLDER = `
    INSERT INTO projects (id, name, data, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      folder = excluded.folder,
      updated_at = excluded.updated_at`;
  const KEEP_FOLDER = `
    INSERT INTO projects (id, name, data, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      updated_at = excluded.updated_at`;

  getDb()
    .prepare(setsFolder ? SET_FOLDER : KEEP_FOLDER)
    .run(id, name, data, folderValue, now, now);
  const saved = { id, name, updatedAt: now, bytes: data.length };
  if (folder !== undefined) saved.folder = folderValue ?? DEFAULT_PROJECT_FOLDER;
  return saved;
}

/**
 * Trims a caller-supplied folder name, mapping blank and the default label to NULL so the
 * column only ever holds a real, deliberate folder.
 */
export function normaliseFolder(folder) {
  if (typeof folder !== "string") return null;
  const trimmed = folder.trim();
  if (trimmed === "" || trimmed === DEFAULT_PROJECT_FOLDER) return null;
  return trimmed;
}

/**
 * Re-files a project without touching its JSON.
 *
 * Separate from `upsertProject` because re-filing is the one folder change a caller can make
 * without holding the project: the editor's list carries summaries only, so requiring the
 * full blob would mean fetching a whole project to change one column. Returns `null` when
 * there is no such project, so the route can answer 404 rather than silently doing nothing.
 */
export function setProjectFolder(id, folder) {
  const now = Date.now();
  const value = normaliseFolder(folder);
  const result = getDb()
    .prepare("UPDATE projects SET folder = ?, updated_at = ? WHERE id = ?")
    .run(value, now, id);
  if (result.changes === 0) return null;
  return { id, folder: value ?? DEFAULT_PROJECT_FOLDER, updatedAt: now };
}

export function deleteProject(id) {
  const db = getDb();
  // Versions go with the project. The editor's delete confirmation says the deletion
  // cannot be undone, and leaving restorable history behind would make that a lie.
  db.prepare("DELETE FROM project_versions WHERE project_id = ?").run(id);
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

/** The row's `updated_at`, for optimistic-concurrency checks. `null` when absent. */
export function getProjectUpdatedAt(id) {
  const row = getDb().prepare("SELECT updated_at FROM projects WHERE id = ?").get(id);
  return row ? row.updated_at : null;
}

/**
 * Media ids that nothing restorable mentions.
 *
 * A substring match on the stored JSON is crude but safe in the direction that matters:
 * an id that appears anywhere is treated as still referenced, so this never deletes
 * media that is in use. Worst case it keeps something too long.
 *
 * Version blobs count as references, not just the current project rows. A version that
 * cannot be restored because its footage was swept is not a version, and the clip a
 * person removed this morning is exactly the media a naive sweep would collect - the
 * moment before they reach for the history to get it back.
 */
export function findOrphanedMedia() {
  const db = getDb();
  const projects = db.prepare("SELECT data FROM projects").all().map((row) => row.data);
  const versions = db
    .prepare("SELECT data FROM project_versions")
    .all()
    .map((row) => row.data);
  const referenced = [...projects, ...versions];
  const mediaIds = db.prepare("SELECT id FROM media").all().map((row) => row.id);
  return mediaIds.filter((id) => !referenced.some((data) => data.includes(id)));
}

/** Closes the handle, so a test (or a shutdown) can release the file. Reopens on demand. */
export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

/** Raw project JSON blobs, for the substring reference test the sweeps share. */
export function listProjectData() {
  return getDb().prepare("SELECT data FROM projects").all().map((row) => row.data);
}

/** Removes a media row and its component metadata. The file itself is the caller's job. */
export function deleteMediaRow(id) {
  const db = getDb();
  const row = db.prepare("SELECT storage_path FROM media WHERE id = ?").get(id);
  db.prepare("DELETE FROM component_metadata WHERE media_id = ?").run(id);
  const result = db.prepare("DELETE FROM media WHERE id = ?").run(id);
  return result.changes > 0 ? (row?.storage_path ?? null) : null;
}

/* ------------------------------------------------------------------- media */

export function insertMedia({ id, filename, storagePath, mimeType, size, metadata, mediaType }) {
  const now = Date.now();
  const encoded = metadata ? JSON.stringify(metadata) : null;
  getDb()
    .prepare(
      `INSERT INTO media (id, filename, storage_path, mime_type, size, created_at, metadata, media_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         filename = excluded.filename,
         storage_path = excluded.storage_path,
         mime_type = excluded.mime_type,
         size = excluded.size,
         metadata = excluded.metadata,
         media_type = excluded.media_type`,
    )
    .run(id, filename, storagePath, mimeType, size, now, encoded, mediaType ?? null);
  return {
    id, filename, mimeType, size, createdAt: now,
    metadata: metadata ?? null,
    mediaType: mediaType ?? null,
  };
}

export function getMedia(id) {
  const row = getDb().prepare("SELECT * FROM media WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    size: row.size,
    createdAt: row.created_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    mediaType: row.media_type ?? null,
  };
}

export function listMedia(limit = 200) {
  return getDb()
    .prepare("SELECT id, filename, mime_type, size, created_at, metadata, media_type FROM media ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((row) => ({
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      mediaType: row.media_type ?? null,
    }));
}

/* ------------------------------------------------------ component metadata */

/** Replaces Stage 5's localStorage registry (its deferred item #3). */
export function upsertComponentMetadata({ mediaId, componentId, props, background, renderedFileId }) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO component_metadata (media_id, component_id, props, background, rendered_file_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET
         component_id = excluded.component_id,
         props = excluded.props,
         background = excluded.background,
         rendered_file_id = excluded.rendered_file_id,
         updated_at = excluded.updated_at`,
    )
    .run(mediaId, componentId, JSON.stringify(props ?? {}), background ?? null, renderedFileId ?? null, now);
  return { mediaId, updatedAt: now };
}

function rowToComponentMetadata(row) {
  return {
    mediaId: row.media_id,
    componentId: row.component_id,
    props: JSON.parse(row.props),
    background: row.background,
    renderedFileId: row.rendered_file_id,
    updatedAt: row.updated_at,
  };
}

export function getComponentMetadata(mediaId) {
  const row = getDb().prepare("SELECT * FROM component_metadata WHERE media_id = ?").get(mediaId);
  return row ? rowToComponentMetadata(row) : null;
}

export function listComponentMetadata() {
  return getDb()
    .prepare("SELECT * FROM component_metadata ORDER BY updated_at DESC")
    .all()
    .map(rowToComponentMetadata);
}


/* --------------------------------------------------------- project versions */

/**
 * Point-in-time snapshots of a project, so a person can get back to this morning's cut.
 *
 * Deliberately NOT one row per save. Automatic sync writes every few seconds; keeping
 * each of those forever would be thousands of rows nobody can read. Versions are
 * checkpoints: one when someone presses save, one per stretch of continuous editing, and
 * one immediately before a restore so the restore itself can be undone.
 *
 * The whole project JSON is stored rather than a diff. At the ~12KB a real project
 * serialises to, diffing saves little and buys a reconstruct step that can go wrong.
 */

export const VERSION_ORIGINS = ["manual", "auto", "pre-restore"];

export function createProjectVersion({ projectId, project, origin, label }) {
  const data = JSON.stringify(project);
  const id = randomUUID();
  const clipCount = countProjectClips(project);
  const duration = Number(project?.timeline?.duration ?? 0);

  getDb()
    .prepare(
      `INSERT INTO project_versions
         (id, project_id, data, origin, created_at, size_bytes, clip_count, duration, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      data,
      origin,
      Date.now(),
      data.length,
      clipCount,
      Number.isFinite(duration) ? duration : 0,
      label ?? null,
    );

  return getProjectVersionMeta(id);
}

/** Metadata only, newest first - the list view never needs the blobs. */
export function listProjectVersions(projectId) {
  return getDb()
    .prepare(
      `SELECT id, project_id, origin, created_at, size_bytes, clip_count, duration, label
         FROM project_versions
        WHERE project_id = ?
        ORDER BY created_at DESC`,
    )
    .all(projectId)
    .map(toVersionMeta);
}

export function getProjectVersion(versionId) {
  const row = getDb()
    .prepare("SELECT * FROM project_versions WHERE id = ?")
    .get(versionId);
  if (!row) return null;
  return { ...toVersionMeta(row), project: JSON.parse(row.data) };
}

export function getProjectVersionMeta(versionId) {
  const row = getDb()
    .prepare(
      `SELECT id, project_id, origin, created_at, size_bytes, clip_count, duration, label
         FROM project_versions WHERE id = ?`,
    )
    .get(versionId);
  return row ? toVersionMeta(row) : null;
}

/** When this project last had a checkpoint, or null. Drives the interval rule. */
export function getLatestProjectVersionAt(projectId) {
  const row = getDb()
    .prepare(
      "SELECT created_at FROM project_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(projectId);
  return row ? row.created_at : null;
}

export function deleteProjectVersion(versionId) {
  const result = getDb()
    .prepare("DELETE FROM project_versions WHERE id = ?")
    .run(versionId);
  return result.changes > 0;
}

/** Every version blob, for the media sweep's reference test. */
export function listProjectVersionData() {
  return getDb()
    .prepare("SELECT data FROM project_versions")
    .all()
    .map((row) => row.data);
}

function toVersionMeta(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    origin: row.origin,
    createdAt: row.created_at,
    sizeBytes: row.size_bytes,
    clipCount: row.clip_count,
    duration: row.duration,
    label: row.label,
  };
}

function countProjectClips(project) {
  const tracks = project?.timeline?.tracks ?? [];
  const timelineClips = tracks.reduce(
    (total, track) => total + (track?.clips?.length ?? 0),
    0,
  );
  const overlays =
    (project?.textClips?.length ?? 0) +
    (project?.shapeClips?.length ?? 0) +
    (project?.svgClips?.length ?? 0) +
    (project?.stickerClips?.length ?? 0);
  return timelineClips + overlays;
}


/** Every version's metadata across all projects, for the retention sweep. */
export function listAllProjectVersionMeta() {
  return getDb()
    .prepare(
      `SELECT id, project_id, origin, created_at, size_bytes, clip_count, duration, label
         FROM project_versions ORDER BY created_at DESC`,
    )
    .all()
    .map(toVersionMeta);
}
