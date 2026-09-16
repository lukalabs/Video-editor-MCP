#!/usr/bin/env node
/**
 * Build an editable OpenReel project from the command line.
 *
 * Each command reads a project JSON, changes it, and writes it back, so a whole video is
 * a shell script. `export` wraps the result in the {version, project} envelope the
 * editor's Project JSON dialog imports.
 *
 *   project-cli new draft.json --size 1080x1920 --fps 24 --name "s2 ad"
 *   project-cli add-clip  draft.json --media clip.mp4
 *   project-cli subtitles draft.json --cues cues.json --preset hormozi
 *   project-cli component draft.json --component button --props '{...}' --at -4
 *   project-cli text      draft.json --text "Meet Replika." --at -4 --duration 4
 *   project-cli export    draft.json --out project.json
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addClip,
  addMediaItem,
  addTextClip,
  addTrack,
  createProject,
  setSubtitles,
  ProjectKitError,
} from "../../packages/project-kit/src/index.js";
import { CAPTION_PRESETS, scalePreset } from "./presets.js";
import { loadCues } from "./cues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
/** Matches the editor's SCHEMA_VERSION in core/src/storage/project-serializer.ts. */
const SCHEMA_VERSION = "1.2.0";

/* ------------------------------------------------------------------ helpers */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readProject(path) {
  if (!existsSync(path)) die(`no project at ${path} — run "new" first`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeProject(path, project) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(project, null, 2));
}

/** ffprobe the file so the media item carries real dimensions and duration. */
function probe(file) {
  if (!existsSync(file)) die(`no such file: ${file}`);
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0",
     "-show_entries", "stream=width,height,r_frame_rate,codec_name",
     "-show_entries", "format=duration,size",
     "-of", "json", file],
    { encoding: "utf8" },
  );
  const info = JSON.parse(raw);
  const stream = info.streams?.[0] ?? {};
  const [num, den] = String(stream.r_frame_rate ?? "0/1").split("/");

  const hasAudio = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
     "-of", "csv=p=0", file],
    { encoding: "utf8" },
  ).trim().length > 0;

  return {
    duration: Number(info.format?.duration ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    frameRate: Number(den) ? Number(num) / Number(den) : 0,
    codec: stream.codec_name ?? "",
    fileSize: Number(info.format?.size ?? 0),
    hasVideo: stream.width !== undefined,
    hasAudio,
  };
}

/**
 * The editor relinks media by matching `sourceFile.name` and `.size` against files in a
 * folder the user picks, so both must be exact — a path string will never match.
 */
function sourceFileOf(file) {
  const stats = statSync(file);
  return {
    name: basename(file),
    size: stats.size,
    lastModified: Math.round(stats.mtimeMs),
    folder: basename(dirname(file)),
  };
}

/** Negative times count back from the end of the timeline, so "--at -4" is the last 4s. */
function resolveTime(value, project) {
  const time = Number(value);
  if (!Number.isFinite(time)) die(`--at must be a number (got "${value}")`);
  return time < 0 ? Math.max(0, project.timeline.duration + time) : time;
}

/**
 * The timeline stores the front-most track at index 0 (see getVisibleTrackRenderOrder),
 * so footage has to sit last or it paints over the captions and graphics above it.
 */
function keepFootageAtBack(project) {
  const isFootage = (track) => track.type === "video" && !track.role;
  const overlays = project.timeline.tracks.filter((track) => !isFootage(track));
  const footage = project.timeline.tracks.filter(isFootage);
  return { ...project, timeline: { ...project.timeline, tracks: [...overlays, ...footage] } };
}

function trackOfType(project, type, name, role) {
  const existing = project.timeline.tracks.find(
    (track) => (role ? track.role === role : track.type === type && !track.role),
  );
  if (existing) return { project, trackId: existing.id };

  const created = addTrack(project, { name, type, ...(role ? { role, mode: "standard" } : {}) });
  return { project: keepFootageAtBack(created.project), trackId: created.trackId };
}

/* ----------------------------------------------------------------- commands */

function cmdNew(path, args) {
  const [width, height] = String(args.size ?? "1080x1920").split("x").map(Number);
  if (!width || !height) die('--size must look like 1080x1920');

  const project = createProject({
    name: args.name ?? basename(path, ".json"),
    width,
    height,
    frameRate: Number(args.fps ?? 30),
  });
  writeProject(path, project);
  console.log(`created ${path} — ${width}x${height} @ ${project.settings.frameRate}fps`);
}

function cmdAddClip(path, args) {
  if (!args.media) die("--media <file> is required");
  const file = resolve(args.media);
  const metadata = { ...probe(file), __path: file };

  let project = readProject(path);
  const mediaId = args.id ?? `media-${basename(file).replace(/\W+/g, "-")}`;

  ({ project } = addMediaItem(project, {
    id: mediaId,
    name: basename(file),
    metadata,
    sourceFile: sourceFileOf(file),
  }));

  const track = trackOfType(project, "video", "Video 1");
  project = track.project;

  const { project: updated, clipId } = addClip(project, {
    trackId: args.track ?? track.trackId,
    mediaId,
    startTime: args.at ? resolveTime(args.at, project) : 0,
    ...(args.duration ? { duration: Number(args.duration) } : {}),
  });

  writeProject(path, keepFootageAtBack(updated));
  console.log(`added clip ${clipId} (${metadata.width}x${metadata.height}, ${metadata.duration.toFixed(2)}s)`);
}

function cmdSubtitles(path, args) {
  if (!args.cues) die("--cues <file.json> is required");
  const presetName = args.preset ?? "clean";
  const preset = CAPTION_PRESETS[presetName];
  if (!preset) {
    die(`unknown preset "${presetName}". Known: ${Object.keys(CAPTION_PRESETS).join(", ")}`);
  }

  const project = readProject(path);
  const cues = loadCues(
    JSON.parse(readFileSync(resolve(args.cues), "utf8")),
    { uppercase: preset.uppercase },
  );

  const style = scalePreset(preset, project.settings.width);

  if (args.layer) {
    // The editor's own caption feature puts one text clip per cue on a track marked
    // role "captions", which is what makes them a draggable layer. Overlay subtitles
    // animate per word but never appear on the timeline; these are the trade-off.
    let working = project;
    const existing = working.timeline.tracks.find(
      (track) => track.role === "captions" || track.name === "Captions",
    );
    let trackId = existing?.id;
    if (!trackId) {
      const created = trackOfType(working, "video", "Captions", "captions");
      working = created.project;
      trackId = created.trackId;
    }

    for (const cue of cues) {
      ({ project: working } = addTextClip(working, {
        trackId,
        text: cue.text,
        startTime: cue.startTime,
        duration: Math.max(0.1, cue.endTime - cue.startTime),
        style: {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          color: style.color,
          ...(style.backgroundColor && style.backgroundColor !== "rgba(0,0,0,0)"
            ? { backgroundColor: style.backgroundColor }
            : {}),
          ...(style.outlineColor ? { strokeColor: style.outlineColor } : {}),
          ...(style.outlineWidth ? { strokeWidth: style.outlineWidth } : {}),
        },
        transform: { position: { x: 0.5, y: style.verticalAnchor ?? 0.74 } },
        metadata: { captionSource: "project-cli", captionPreset: presetName },
      }));
    }

    writeProject(path, working);
    console.log(`added ${cues.length} caption clips on a Captions track — ${preset.label}`);
    return;
  }

  const { project: updated, subtitleCount } = setSubtitles(project, {
    subtitles: cues,
    style,
    animationStyle: preset.animationStyle,
  });

  writeProject(path, updated);
  console.log(`set ${subtitleCount} subtitles — ${preset.label} (overlay; use --layer for clips)`);
}

function cmdComponent(path, args) {
  const component = args.component ?? "button";
  let project = readProject(path);

  let file = args.file ? resolve(args.file) : null;
  if (!file) {
    // Render through the component library, which needs no Redis or render-service.
    const out = resolve(args.out ?? `${REPO}/storage/caption-work/cta/${component}-${Date.now()}.webm`);
    mkdirSync(dirname(out), { recursive: true });
    console.log(`rendering ${component}…`);
    execFileSync(
      "node",
      ["scripts/render.mjs",
       "--component", component,
       "--fps", String(project.settings.frameRate),
       "--width", String(project.settings.width),
       "--height", String(project.settings.height),
       "--props", args.props ?? "{}",
       "--out", out],
      { cwd: `${REPO}/packages/component-library`, stdio: "inherit" },
    );
    file = out;
  }

  const metadata = { ...probe(file), __path: file };
  const mediaId = `media-${basename(file).replace(/\W+/g, "-")}`;
  ({ project } = addMediaItem(project, {
    id: mediaId,
    name: basename(file),
    metadata,
    sourceFile: sourceFileOf(file),
  }));

  const track = trackOfType(project, "graphics", "Graphics");
  project = track.project;

  const startTime = resolveTime(args.at ?? 0, project);
  const { project: updated, clipId } = addClip(project, {
    trackId: track.trackId,
    mediaId,
    startTime,
    metadata: { componentId: component, ...(args.props ? { props: JSON.parse(args.props) } : {}) },
  });

  writeProject(path, updated);
  console.log(`added ${component} clip ${clipId} at ${startTime.toFixed(2)}s`);
}

function cmdText(path, args) {
  if (!args.text) die("--text is required");
  let project = readProject(path);

  const track = trackOfType(project, "text", "Text");
  project = track.project;

  const { project: updated, textClipId } = addTextClip(project, {
    trackId: track.trackId,
    text: String(args.text).replace(/\\n/g, "\n"),
    startTime: resolveTime(args.at ?? 0, project),
    duration: Number(args.duration ?? 3),
    ...(args.style ? { style: JSON.parse(args.style) } : {}),
    ...(args.transform ? { transform: JSON.parse(args.transform) } : {}),
  });

  writeProject(path, updated);
  console.log(`added text clip ${textClipId}`);
}

function cmdExport(path, args) {
  const project = readProject(path);
  const out = args.out ?? path.replace(/\.json$/, ".project.json");

  const file = {
    version: SCHEMA_VERSION,
    ...(project.minimumReaderVersion ? { minimumReaderVersion: project.minimumReaderVersion } : {}),
    ...(project.capabilities ? { capabilities: project.capabilities } : {}),
    project,
  };

  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(file, null, 2));
  console.log(`wrote ${out}`);
  console.log("Open the editor -> Project JSON -> Import, and paste this file's contents.");
}

/**
 * Copies the project and every file it references into the dev server's public folder and
 * prints the URL that opens it. The editor fetches the media by name from `media=`, so the
 * project opens ready to play rather than asking for a manual relink.
 */
function cmdServe(path, args) {
  const project = readProject(path);
  const webRoot = `${REPO}/apps/editor/apps/web/public`;
  const slug = basename(path, ".json");
  const projectDir = `${webRoot}/cli-projects`;
  const mediaDir = `${projectDir}/${slug}-media`;

  mkdirSync(mediaDir, { recursive: true });

  for (const item of project.mediaLibrary.items) {
    const source = findSourcePath(item);
    if (!source || !existsSync(source)) {
      console.warn(`  ! could not find ${item.name} — it will need relinking`);
      continue;
    }
    copyFileSync(source, `${mediaDir}/${item.sourceFile?.name ?? item.name}`);
  }

  writeFileSync(`${projectDir}/${slug}.project.json`, JSON.stringify({
    version: SCHEMA_VERSION,
    ...(project.minimumReaderVersion ? { minimumReaderVersion: project.minimumReaderVersion } : {}),
    ...(project.capabilities ? { capabilities: project.capabilities } : {}),
    project,
  }, null, 2));

  const host = args.host ?? "http://localhost:5173";
  const url =
    `${host}/#/editor` +
    `?open=/cli-projects/${slug}.project.json` +
    `&media=/cli-projects/${slug}-media`;

  console.log(url);
  if (args.open) execFileSync("open", [url]);
}

/** add-clip and component stash the absolute path in metadata so serve can copy the file. */
function findSourcePath(item) {
  return item.metadata?.__path ?? null;
}

const COMMANDS = {
  new: cmdNew,
  "add-clip": cmdAddClip,
  subtitles: cmdSubtitles,
  component: cmdComponent,
  text: cmdText,
  export: cmdExport,
  serve: cmdServe,
};

/* --------------------------------------------------------------------- main */

const args = parseArgs(process.argv.slice(2));
const [command, projectPath] = args._;

if (!command || !COMMANDS[command]) {
  console.error(`usage: project-cli <${Object.keys(COMMANDS).join("|")}> <project.json> [options]`);
  process.exit(1);
}
if (!projectPath) die("a project path is required");

try {
  COMMANDS[command](projectPath, args);
} catch (error) {
  if (error instanceof ProjectKitError) die(`${error.code}: ${error.message}`);
  throw error;
}
