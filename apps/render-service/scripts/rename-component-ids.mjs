#!/usr/bin/env node
/**
 * Moves stored references from old component ids to new ones after a rename.
 *
 *   node scripts/rename-component-ids.mjs --preset cta-drop-rep --dry-run
 *   node scripts/rename-component-ids.mjs --preset cta-drop-rep
 *   node scripts/rename-component-ids.mjs old-id=new-id [old-id=new-id ...]
 *
 * Targets the same database the service uses (DB_PATH, else storage/video-editor.sqlite).
 * Safe to run while the service is up, and safe to run twice. See src/component-rename.js
 * for what it changes and why each place matters.
 */
import process from "node:process";

import { closeDb, getDb } from "../src/db.js";
import { RENAME_PRESETS, renameComponentIds } from "../src/component-rename.js";
import { config } from "../src/config.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mapping = {};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--dry-run") continue;
  if (arg === "--preset") {
    const preset = RENAME_PRESETS[args[i + 1]];
    if (!preset) {
      console.error(`Unknown preset "${args[i + 1]}". Known: ${Object.keys(RENAME_PRESETS).join(", ")}`);
      process.exit(2);
    }
    Object.assign(mapping, preset);
    i += 1;
    continue;
  }
  const [from, to] = arg.split("=");
  if (!from || !to) {
    console.error(`Expected old=new, got "${arg}"`);
    process.exit(2);
  }
  mapping[from] = to;
}

if (Object.keys(mapping).length === 0) {
  console.error("Nothing to rename. Pass --preset <name> or old=new pairs.");
  process.exit(2);
}

const report = renameComponentIds(getDb(), mapping, { dryRun });
closeDb();

console.log(`${dryRun ? "[dry run, nothing written] " : ""}database: ${config.dbPath}`);
console.log(`component_metadata rows: ${report.componentMetadata}`);
console.log(`projects: ${report.projects.length} (${report.clips} clips)`);
for (const project of report.projects) console.log(`  ${project.name} (${project.id}): ${project.clips} clips`);
console.log(`project versions: ${report.versions} (${report.versionClips} clips)`);
