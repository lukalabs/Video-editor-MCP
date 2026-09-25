/**
 * Moves stored references from old component ids to new ones, after a component rename.
 *
 * Renaming a component in the library leaves data that points at the old id, and with the
 * old id gone from the catalogue those clips can no longer be re-rendered or edited - they
 * still play, but the Component Library panel silently refuses to open them. Three places
 * hold the id, and all three matter:
 *
 *   - `component_metadata.component_id`: the mediaId -> component mapping the editor uses to
 *     stamp a clip when generated media is placed on a track.
 *   - `clip.metadata.componentId` on timeline clips in saved projects: what the panel's
 *     re-render mode actually reads. Fixing only the table does NOT fix placed clips - the
 *     editor skips re-stamping a clip that already carries component metadata.
 *   - the same field inside `project_versions` snapshots, so restoring a version does not
 *     bring the dead id back. Only the identifier changes; the snapshot's content does not.
 *
 * Media item names are left alone - they are labels, not references.
 *
 * One transaction, all or nothing. Idempotent: a second run finds nothing to change. A
 * changed project gets a fresh `updated_at`, so a browser that still has the old copy open
 * gets a conflict on its next save instead of silently writing the old ids back.
 */

const COMPONENT_LIBRARY_SOURCE = "component-library";

/** Rewrites clip.metadata.componentId in one project's data. Returns how many clips changed. */
function renameInProject(project, mapping) {
  let changed = 0;
  for (const track of project?.timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const metadata = clip.metadata;
      if (!metadata || metadata.source !== COMPONENT_LIBRARY_SOURCE) continue;
      const next = mapping[metadata.componentId];
      if (next) {
        metadata.componentId = next;
        changed += 1;
      }
    }
  }
  return changed;
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {Record<string, string>} mapping old id -> new id
 * @param {{ dryRun?: boolean, now?: number }} [options]
 */
export function renameComponentIds(db, mapping, { dryRun = false, now = Date.now() } = {}) {
  const pairs = Object.entries(mapping);
  if (pairs.length === 0) throw new Error("No id pairs given");
  for (const [from, to] of pairs) {
    if (!from || !to || from === to) throw new Error(`Invalid rename pair "${from}" -> "${to}"`);
  }

  const report = { componentMetadata: 0, projects: [], versions: 0, clips: 0, versionClips: 0 };
  db.exec("BEGIN");
  try {
    const updateMeta = db.prepare("UPDATE component_metadata SET component_id = ? WHERE component_id = ?");
    for (const [from, to] of pairs) {
      report.componentMetadata += Number(updateMeta.run(to, from).changes);
    }

    const saveProject = db.prepare("UPDATE projects SET data = ?, updated_at = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, name, data FROM projects").all()) {
      const project = JSON.parse(row.data);
      const clips = renameInProject(project, mapping);
      if (clips > 0) {
        saveProject.run(JSON.stringify(project), now, row.id);
        report.projects.push({ id: row.id, name: row.name, clips });
        report.clips += clips;
      }
    }

    const saveVersion = db.prepare("UPDATE project_versions SET data = ?, size_bytes = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, data FROM project_versions").all()) {
      const project = JSON.parse(row.data);
      const clips = renameInProject(project, mapping);
      if (clips > 0) {
        const data = JSON.stringify(project);
        saveVersion.run(data, data.length, row.id);
        report.versions += 1;
        report.versionClips += clips;
      }
    }

    db.exec(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return report;
}

/** Named mappings for renames that have actually happened, so they can be re-applied. */
export const RENAME_PRESETS = {
  // Stage 33: the generic CTA buttons lost the -Rep suffix, which now marks branded
  // components only.
  "cta-drop-rep": Object.fromEntries(
    ["pulse-glow", "shimmer", "outline-draw", "fill-sweep", "ghost-float", "press-3d",
      "bounce-in", "blink-flash", "gradient-flow", "ripple-rings"].map((style) => [
      `button-${style}-Rep`,
      `button-${style}`,
    ]),
  ),
};
