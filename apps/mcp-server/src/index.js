#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { withMcpProjectSuffix, findDuplicateProject } from "./naming.js";
import { SERVICE_URL, service } from "./service.js";

/**
 * What the render-service reports for a project with no folder.
 *
 * Duplicated here rather than imported: this package depends only on the render-service's
 * HTTP API, never on its internals, so it cannot reach into db.js for the constant. It is
 * only ever used to write tool descriptions and to fill in a missing field, never to decide
 * what gets stored - the server is authoritative.
 */
const DEFAULT_PROJECT_FOLDER = "Uncategorized";

/**
 * MCP server for the browser video editor.
 *
 * Every tool is a thin wrapper over one render-service HTTP endpoint — no business logic
 * lives here. Long-running work (component renders, project exports) is polled inside the
 * tool so the model gets a single answer instead of having to poll itself.
 *
 * No authentication anywhere: this speaks to a localhost-only service. Do not expose it.
 */

const OPS_VOCABULARY = `
Each entry is an object with an "op" field plus that op's parameters. Ops are applied in
order, atomically: if any one fails, none are saved. Ids created along the way come back in
the response ("results"), so you can add a clip in one call and trim it in the next.

Timeline model: a project has tracks; each track holds clips positioned in seconds.
"Video 1" (the FIRST track) renders on TOP of later tracks — put overlays on an earlier
track than the footage they sit over.

Available ops:

- add_media { id, name?, metadata, type? }
    Registers already-uploaded media in the project library. Pass the "mediaId" and
    "metadata" object exactly as returned by upload_media. Required before add_clip.
    type ("video" | "audio" | "image") is inferred from the metadata and only needs
    passing to override it - upload_media returns the same value as "mediaType".

- add_track { name? }
    Appends a track. Returns { trackId }.

- add_clip { trackId, mediaId, startTime, duration?, inPoint?, metadata?, allowOverlap? }
    Places media on a track. startTime is where it begins on the timeline (seconds).
    duration defaults to the media's full length; inPoint (default 0) is how far into the
    source the clip starts, so { inPoint: 2, duration: 3 } uses source seconds 2-5.
    Still images have no inherent length (metadata.duration is 0), so their clips default
    to 5 seconds - pass duration explicitly to hold one on screen for longer.
    Overlapping an existing clip on the same track is rejected unless allowOverlap: true.
    Returns { clipId }.

- trim_clip { clipId, startTime?, duration?, inPoint? }
    Changes any of those; outPoint is kept consistent automatically. Cannot extend past the
    source media's length.

- move_clip { clipId, trackId?, startTime? }
    Moves a clip to another track and/or another time.

- split_clip { clipId, time }
    Splits at an absolute timeline time that must fall strictly inside the clip. Returns
    { clipId, newClipId } — the original keeps the earlier half.

- remove_clip { clipId }
    Deletes the clip and any transitions referencing it.

- set_effect { clipId, type, params?, enabled? }
    Adds or replaces an effect on a clip (replaced by type, so calling it twice with the
    same type updates rather than duplicates). Useful types: "chromaKey" (params:
    keyColor {r,g,b} 0-1, tolerance, edgeSoftness, spillSuppression), "brightness",
    "contrast", "saturation", "blur", "grayscale", "invert", "sepia", "vignette", "grain",
    "sharpen". Omitted params fall back to sensible defaults.

- remove_effect { clipId, type? | effectId? }

- set_audio_fade { clipId, fadeInSeconds?, fadeOutSeconds? }
    Fades the clip's audio up from silence at its start and/or down to silence at its end,
    over that many seconds. Linear, applied to the clip's own gain, and included in the
    exported mix - no need to pre-process the file with ffmpeg before uploading. Pass one
    end to change only that end; 0 on both removes the fade. Fades that together exceed the
    clip's duration are rejected. Use set_clip_transform's volume for a flat level change.

- set_clip_transform { clipId, transform?, opacity?, volume? }
    transform accepts { position:{x,y}, scale:{x,y}, rotation, anchor:{x,y}, fitMode }.
    fitMode is "contain" | "cover" | "stretch". opacity and volume are 0-1.
    A video clip's OWN embedded audio is mixed into the export by default, alongside
    anything on your audio tracks. If you only want your own music or voiceover, silence
    the video clip with volume: 0 - do not pre-process the file or rebuild the audio bed.
    Silence in an audio track is exported as real silence, so gaps and a music bed shorter
    than the timeline are fine and stay in sync.

- add_text_clip { trackId, text, startTime, duration, style?, transform? }
    A text overlay. style accepts { fontFamily, fontSize, fontWeight, color, strokeColor,
    strokeWidth, textAlign, verticalAlign, lineHeight, letterSpacing }. transform.position
    is NORMALISED here (0-1, so { x: 0.5, y: 0.5 } is centred), unlike clip transforms
    which are pixel offsets. Returns { textClipId }.

- add_transition { clipAId, clipBId?, type, duration?, params?, edge? }
    A transition between two clips on the same track (or anchored to one clip's edge with
    edge: "in" | "out" and no clipBId). type is one of: crossfade, dipToBlack, dipToWhite,
    wipe, slide, zoom, push, circleReveal, blur, whipPan, radialWipe, pixelate, glitch,
    blinds, diamondReveal, spin, flip, splitReveal, flash, filmBurn, mosaic, ripple,
    pageTurn, colorSplit. params may be omitted entirely — every type has defaults (e.g.
    wipe/slide take { direction: "left"|"right"|"up"|"down" }, dipToBlack takes
    { holdDuration }).

- set_clip_mask { clipId, svg? | svgPath? | points? | savedMaskName? | savedMaskId?, feather?, expansion?, inverted?, opacity?, replace? }
    Masks a clip to a shape, so only what is inside the shape shows. Give the shape ONE of:
      svg           - SVG markup as a string
      svgPath       - a path to an .svg file on this machine, read for you
      points        - the outline directly, as [{ x, y, handleIn?, handleOut? }, …]
      savedMaskName - a shape from the saved-mask library (see list_saved_masks); names
                      match ignoring case
      savedMaskId   - the same, by id
    A saved mask is COPIED onto the clip and re-fitted to this project's frame, keeping its
    proportions and its place in the frame - a circle saved from a vertical project stays a
    circle in a horizontal one. The clip keeps no link to the library, so deleting or
    replacing a library entry later never changes a clip that already has it.
    Coordinates are 0-1 of the frame ({ x: 0.5, y: 0.5 } is the centre); handleIn/handleOut
    are absolute points in the same space, not offsets, and omitting them gives a straight
    edge. Only SINGLE-PATH SVGs are accepted: a file with several paths, groups, or shapes
    like <rect> is rejected with a count rather than flattened, and so are elliptical arcs
    (A commands), transform attributes and paths with more than one subpath (a shape with a
    hole). The artwork is fitted inside the frame with its aspect ratio kept, not stretched.
    feather softens the edge in pixels, expansion grows (+) or shrinks (-) the shape,
    inverted hides what is inside instead, opacity is 0-1. Adds to any masks the clip
    already has; replace: true clears that clip's masks first. The result is an ordinary
    editable mask, identical to importing the same file in the editor's Mask panel.
    Returns { maskId, pointCount, warnings }.

- remove_clip_mask { clipId }
    Removes every mask on the clip. Returns { removed }.

- rename_project { name }
`.trim();

const server = new McpServer(
  { name: "video-editor", version: "0.1.0" },
  {
    instructions:
      "Build and export browser-video-editor projects. Typical flow: list_components to " +
      "see what animated overlays exist, generate_component to render one, upload_media " +
      "for any footage on disk, create_project, apply_project_ops to lay out the timeline, " +
      "then export_project. Component renders and exports are polled internally and only " +
      "return when finished, so a single call can take tens of seconds.",
  },
);

/** Every tool returns text plus a machine-readable copy of the same payload. */
function ok(summary, data) {
  return {
    content: [
      { type: "text", text: data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}` },
    ],
    structuredContent: data === undefined ? undefined : { result: data },
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Turns `svgPath` into `svg` by reading the file here.
 *
 * The ops themselves are pure JSON applied on the server, which has no access to the
 * caller's disk and no business doing file I/O - but an agent with an .svg on hand should
 * not have to inline it by hand. Reading it at this edge keeps both of those true.
 */
async function resolveSvgPaths(ops) {
  const out = [];
  for (const entry of ops) {
    if (!entry || typeof entry.svgPath !== "string") {
      out.push(entry);
      continue;
    }
    const { svgPath, ...rest } = entry;
    if (rest.svg !== undefined) {
      throw new Error("Pass either svg or svgPath to set_clip_mask, not both.");
    }
    let svg;
    try {
      svg = await readFile(svgPath, "utf8");
    } catch (error) {
      throw new Error(`Could not read the SVG at ${svgPath}: ${error.message}`);
    }
    out.push({ ...rest, svg });
  }
  return out;
}

server.registerTool(
  "list_components",
  {
    title: "List animated components",
    description:
      "Lists the animated overlay components available to render. Returns each component's " +
      "id, name, description and parameter schema — parameter types follow the editor's " +
      "vocabulary: text, number, color, boolean, media. Some text params carry several " +
      "lines in one delimited string (a chat thread's messages, a headline's phrases); the " +
      "param's own description states the delimiter, and its `lineSeparator` gives the same " +
      "answer as data. Call this before generate_component so you know which ids and props " +
      "exist — the catalogue is read fresh from disk, so do not rely on a remembered list.",
    inputSchema: {},
  },
  async () => {
    try {
      const { components } = await service.listComponents();
      return ok(`${components.length} components available.`, components);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "generate_component",
  {
    title: "Render an animated component",
    description:
      "Renders one animated component to a video file with a transparent background and " +
      "waits for it to finish (typically 20-60 seconds — this call blocks until done, you " +
      "do not need to poll). Props must match the component's schema from list_components; " +
      "anything omitted uses its default. Returns the rendered file's id, byte size and a " +
      "local file path you can pass straight to upload_media. Pass background as a hex " +
      "colour only if you specifically want a solid backdrop instead of transparency.",
    inputSchema: {
      componentId: z.string().describe('Component id from list_components, e.g. "orbit-headline-Rep".'),
      props: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          "Component parameters, keyed exactly as in that component's own schema from " +
            "list_components; anything omitted uses its default. Example for " +
            'orbit-headline-Rep: { "text": "Your headline", "durationInSeconds": 4 }.',
        ),
      background: z
        .string()
        .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
        .optional()
        .describe('Optional solid backdrop hex colour (e.g. "#00ff00"). Omit for transparency.'),
      downloadTo: z
        .string()
        .optional()
        .describe("Optional local directory to save the rendered file into."),
    },
  },
  async ({ componentId, props, background, downloadTo }) => {
    try {
      const queued = await service.startRender({ componentId, props: props ?? {}, background: background ?? null });
      const job = await service.waitForJob(() => service.renderStatus(queued.jobId), {
        timeoutMs: 10 * 60_000,
        label: `Component render for "${componentId}"`,
      });

      let saved = null;
      if (downloadTo) {
        saved = await service.downloadToFile(job.url, path.join(downloadTo, job.file));
      }

      return ok(
        `Rendered ${componentId} → ${job.file} (${job.bytes} bytes, ${job.frames} frames).`,
        {
          renderedFileId: job.file,
          bytes: job.bytes,
          frames: job.frames,
          durationInSeconds: job.durationInSeconds,
          serviceUrl: `${SERVICE_URL}${job.url}`,
          localPath: saved?.path ?? null,
          props: job.props,
        },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "upload_media",
  {
    title: "Upload a media file",
    description:
      "Uploads a local video, audio or image file to the editor's server-side media store " +
      "and probes it with ffprobe. Returns the mediaId, a metadata object (duration, width, " +
      "height, frameRate, codec, hasAudio …) and mediaType (\"video\" | \"audio\" | " +
      "\"image\"). Pass mediaId and metadata to the add_media op in apply_project_ops before " +
      "placing the media on a timeline. Use this for footage on disk and for the file " +
      "returned by generate_component (pass its localPath). Still images come back with " +
      "duration 0 - that means \"no inherent length\", not an error; their clips default to " +
      "5 seconds unless add_clip is given a duration.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to a file on this machine."),
      mediaId: z
        .string()
        .optional()
        .describe("Optional id to store it under; a uuid is generated when omitted."),
      mimeType: z.string().optional().describe("Optional MIME type override."),
    },
  },
  async ({ filePath, mediaId, mimeType }) => {
    try {
      const record = await service.uploadMedia({ filePath, mediaId, mimeType });
      const isStill = record.mediaType === "image";
      return ok(
        `Uploaded ${record.filename} as ${record.id} (${record.size} bytes, ${record.mediaType ?? "unknown type"}).`,
        {
          mediaId: record.id,
          name: record.filename,
          size: record.size,
          mediaType: record.mediaType,
          metadata: record.metadata,
          hint: isStill
            ? "Still image: pass { id: mediaId, name, metadata } to add_media, then give add_clip an explicit duration (it defaults to 5s)."
            : "Pass { id: mediaId, name, metadata } to the add_media op.",
        },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_projects",
  {
    title: "List saved projects",
    description:
      "Lists projects saved on the server, newest first, with id, name, folder and " +
      "last-updated time. Use it to find an existing project to modify or export - and to " +
      "see which folders already exist, so related work can go in the same one instead of " +
      "inventing a new folder each time. Projects with no folder report " +
      `"${DEFAULT_PROJECT_FOLDER}". Pass folder to list only that folder.`,
    inputSchema: {
      folder: z
        .string()
        .optional()
        .describe(
          "Only list projects in this folder. Omit for all of them. " +
            `"${DEFAULT_PROJECT_FOLDER}" lists the ones that have never been filed.`,
        ),
    },
  },
  async ({ folder }) => {
    try {
      const { projects } = await service.listProjects(folder);
      const where = folder ? ` in "${folder}"` : "";
      return ok(`${projects.length} saved projects${where}.`, projects);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_saved_masks",
  {
    title: "List saved masks",
    description:
      "Lists the saved-mask library: named mask shapes that can be applied to any clip in " +
      "any project with apply_project_ops' set_clip_mask { savedMaskName } (or savedMaskId). " +
      "Each entry has id, name, pointCount, the frame size it was made in (sourceWidth x " +
      "sourceHeight) and previewPath, an SVG outline to draw with viewBox=\"0 0 sourceWidth " +
      "sourceHeight\". Check here before importing the same logo or silhouette again - " +
      "entries are only ever added deliberately, with save_mask or the editor's Save as " +
      "reusable mask, so this is a curated list, not a history of every import.",
    inputSchema: {},
  },
  async () => {
    try {
      const { masks } = await service.listSavedMasks();
      return ok(`${masks.length} saved masks.`, masks);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "save_mask",
  {
    title: "Save a reusable mask",
    description:
      "Adds a named shape to the saved-mask library so it can be applied to any clip in any " +
      "project later with set_clip_mask { savedMaskName }. Give the shape ONE of: svg (markup), " +
      "svgPath (an .svg file on this machine, read for you), path + sourceWidth + sourceHeight " +
      "(normalized 0-1 points and the pixel size of the frame they are normalized to), or " +
      "projectId + clipId (+ maskId if that clip has more than one mask) to save a clip's " +
      "current mask. SVGs follow set_clip_mask's rules: single path only, no arcs or " +
      "transforms. Only the shape is saved - feather, inversion and opacity are chosen each " +
      "time it is applied - and only the current shape of an animated mask. Track mattes " +
      "cannot be saved: their shape comes from another clip. Names must be unique ignoring " +
      "case; there is no rename, so to change one, save it again under the new name. " +
      "Deleting an entry never affects clips it was already applied to.",
    inputSchema: {
      name: z.string().describe("Name to save it under. Unique, ignoring case."),
      svg: z.string().optional().describe("SVG markup for a single-path shape."),
      svgPath: z.string().optional().describe("Path to a single-path .svg file on this machine."),
      path: z
        .object({ points: z.array(z.object({ x: z.number(), y: z.number() }).passthrough()) })
        .passthrough()
        .optional()
        .describe("The outline as normalized 0-1 points, { points: [{ x, y, handleIn?, handleOut? }] }."),
      sourceWidth: z.number().optional().describe("Pixel width of the frame `path` is normalized to."),
      sourceHeight: z.number().optional().describe("Pixel height of the frame `path` is normalized to."),
      projectId: z.string().optional().describe("Save a clip's current mask: the project it is in."),
      clipId: z.string().optional().describe("Save a clip's current mask: the clip."),
      maskId: z.string().optional().describe("Which of the clip's masks, if it has more than one."),
    },
  },
  async ({ svgPath, ...body }) => {
    try {
      if (svgPath !== undefined) {
        if (body.svg !== undefined) throw new Error("Pass either svg or svgPath, not both.");
        try {
          body.svg = await readFile(svgPath, "utf8");
        } catch (error) {
          throw new Error(`Could not read the SVG at ${svgPath}: ${error.message}`);
        }
      }
      const saved = await service.saveMask(body);
      const notes = saved.warnings?.length ? ` Note: ${saved.warnings.join(" ")}` : "";
      return ok(
        `Saved "${saved.name}" (${saved.pointCount} points). Apply it with set_clip_mask ` +
          `{ savedMaskName: "${saved.name}" }.${notes}`,
        saved,
      );
    } catch (error) {
      if (error?.status === 409) {
        return fail(new Error(`${error.body?.error ?? "That name is taken"}. Pick another name.`));
      }
      if (error?.status === 400 || error?.status === 404) {
        return fail(new Error(`${error.body?.error ?? "Invalid request"}` +
          (error.body?.code ? ` [${error.body.code}]` : "")));
      }
      return fail(error);
    }
  },
);

server.registerTool(
  "create_project",
  {
    title: "Create an empty project",
    description:
      "Creates and saves an empty project with one video track, returning its projectId and " +
      "that track's trackId — you need the trackId for add_clip and add_text_clip. Defaults " +
      "to 1920x1080 at 30fps. Pass a short, descriptive summary of the task as the name; " +
      'a "-MCP" suffix is appended automatically to mark the project as agent-created, so ' +
      "do not add it yourself. If a project with the same name already exists in the same " +
      "folder, this returns THAT project instead of making a second one — keep editing it " +
      "with apply_project_ops. Pass allowDuplicateName to create one anyway.",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          'A short, descriptive summary of the task, e.g. "Q4 product launch teaser". ' +
            'The "-MCP" suffix is added for you.',
        ),
      width: z.number().int().positive().optional().describe("Canvas width in pixels (default 1920)."),
      height: z.number().int().positive().optional().describe("Canvas height in pixels (default 1080)."),
      frameRate: z.number().positive().optional().describe("Frames per second (default 30)."),
      folder: z
        .string()
        .optional()
        .describe(
          "Free-text folder to file the project under, e.g. \"Client Acme\". Call " +
            "list_projects first and reuse an existing folder when the work is related. " +
            `Omitted means "${DEFAULT_PROJECT_FOLDER}".`,
        ),
      allowDuplicateName: z
        .boolean()
        .optional()
        .describe(
          "Create a new project even when one of the same name already exists in the " +
            "same folder. Default false, which returns the existing project instead.",
        ),
    },
  },
  async ({ name, width, height, frameRate, folder, allowDuplicateName }) => {
    try {
      // Applied here rather than trusted to the caller: see naming.js for why.
      const projectName = withMcpProjectSuffix(name);

      // Reuse rather than duplicate. An agent iterating on one idea calls this per
      // attempt, and nothing here used to check, so the list filled with several rows
      // sharing a name and only their uuid to tell them apart.
      if (!allowDuplicateName) {
        const { projects } = await service.listProjects();
        const existing = findDuplicateProject(projects, projectName, folder);
        if (existing) {
          const record = await service.getProject(existing.id);
          const existingTracks = record.project.timeline.tracks.map((track) => ({
            trackId: track.id,
            name: track.name,
          }));
          return ok(
            `Project "${existing.name}" (${existing.id}) already exists in folder ` +
              `"${existing.folder ?? DEFAULT_PROJECT_FOLDER}" — returning it instead of ` +
              "creating a second one. Continue editing it with apply_project_ops, or " +
              "call create_project again with allowDuplicateName to make a new one.",
            {
              projectId: existing.id,
              name: existing.name,
              folder: existing.folder ?? DEFAULT_PROJECT_FOLDER,
              updatedAt: existing.updatedAt,
              tracks: existingTracks,
              settings: record.project.settings,
              reusedExisting: true,
            },
          );
        }
      }

      const created = await service.createProject({
        name: projectName,
        width,
        height,
        frameRate,
        folder,
      });
      const tracks = created.project.timeline.tracks.map((track) => ({ trackId: track.id, name: track.name }));
      return ok(
        `Created project "${created.name}" (${created.id}) in folder ` +
          `"${created.folder ?? DEFAULT_PROJECT_FOLDER}".`,
        {
        projectId: created.id,
        name: created.name,
        folder: created.folder ?? DEFAULT_PROJECT_FOLDER,
        updatedAt: created.updatedAt,
        tracks,
        settings: created.project.settings,
        reusedExisting: false,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "load_project",
  {
    title: "Load a project",
    description:
      "Returns a saved project's current state: its tracks with their clips (id, mediaId, " +
      "startTime, duration, inPoint/outPoint, effects), text clips, media library and total " +
      "timeline duration. Use it to see what you are editing before calling " +
      "apply_project_ops, and to get clip ids. Set includeRaw for the full untrimmed JSON.",
    inputSchema: {
      projectId: z.string().describe("Project id from create_project or list_projects."),
      includeRaw: z
        .boolean()
        .optional()
        .describe("Include the complete project JSON as well as the summary (verbose)."),
    },
  },
  async ({ projectId, includeRaw }) => {
    try {
      const record = await service.getProject(projectId);
      const project = record.project;
      const summary = {
        projectId: record.id,
        name: record.name,
        updatedAt: record.updatedAt,
        settings: project.settings,
        timelineDuration: project.timeline.duration,
        tracks: project.timeline.tracks.map((track) => ({
          trackId: track.id,
          name: track.name,
          locked: track.locked,
          clips: track.clips.map((clip) => ({
            clipId: clip.id,
            mediaId: clip.mediaId,
            startTime: clip.startTime,
            duration: clip.duration,
            inPoint: clip.inPoint,
            outPoint: clip.outPoint,
            effects: (clip.effects ?? []).map((effect) => effect.type),
            componentId: clip.metadata?.componentId ?? null,
          })),
          transitions: (track.transitions ?? []).map((transition) => ({
            transitionId: transition.id,
            type: transition.type,
            duration: transition.duration,
          })),
        })),
        textClips: (project.textClips ?? []).map((clip) => ({
          textClipId: clip.id,
          text: clip.text,
          startTime: clip.startTime,
          duration: clip.duration,
        })),
        media: project.mediaLibrary.items.map((item) => ({
          mediaId: item.id,
          name: item.name,
          duration: item.metadata?.duration ?? null,
        })),
        ...(includeRaw ? { raw: project } : {}),
      };
      return ok(`Project "${record.name}" — ${summary.timelineDuration}s timeline.`, summary);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "apply_project_ops",
  {
    title: "Edit a project timeline",
    description:
      "Applies a list of editing operations to a saved project, atomically — if any " +
      "operation is invalid, nothing is saved and the error says which one failed. This is " +
      "the main editing tool: adding media to the library, placing and trimming clips, " +
      "adding text overlays, effects and transitions.\n\n" +
      `${OPS_VOCABULARY}\n\n` +
      "Concurrency: the tool reads the project's current updatedAt and sends it as a guard, " +
      "so a save that would overwrite someone else's newer change fails with a clear " +
      "conflict error rather than silently clobbering it. Re-run the call to retry against " +
      "the newer state.",
    inputSchema: {
      projectId: z.string().describe("Project id to edit."),
      ops: z
        .array(z.object({ op: z.string() }).passthrough())
        .min(1)
        .describe('Operations to apply in order, e.g. [{ "op": "add_clip", "trackId": "…", "mediaId": "…", "startTime": 0 }].'),
    },
  },
  async ({ projectId, ops }) => {
    try {
      const resolved = await resolveSvgPaths(ops);
      // Load-then-write: fetch the current updatedAt and pass it as the guard, so a
      // concurrent change surfaces as a conflict instead of an overwrite.
      const current = await service.getProject(projectId);
      const applied = await service.applyOps(projectId, {
        ops: resolved,
        expectedUpdatedAt: current.updatedAt,
      });
      return ok(
        `Applied ${ops.length} operation(s). Timeline is now ${applied.timelineDuration}s.`,
        {
          projectId,
          updatedAt: applied.updatedAt,
          timelineDuration: applied.timelineDuration,
          results: applied.results,
        },
      );
    } catch (error) {
      if (error?.status === 409) {
        return fail(
          new Error(
            "Conflict: the project changed on the server since this call read it " +
              `(server ${error.body?.serverUpdatedAt}, expected ${error.body?.yourUpdatedAt}). ` +
              "Call load_project to see the current state, then apply your operations again.",
          ),
        );
      }
      if (error?.status === 400) {
        return fail(
          new Error(
            `${error.body?.error ?? "Invalid operations"}` +
              (error.body?.code ? ` [${error.body.code}]` : "") +
              " — nothing was saved.",
          ),
        );
      }
      return fail(error);
    }
  },
);

server.registerTool(
  "export_project",
  {
    title: "Export a project to video",
    description:
      "Renders a saved project to an MP4 and waits for it to finish (roughly real time — a " +
      "10-second timeline takes tens of seconds; this call blocks until done). The export " +
      "runs the real editor in a headless browser, so it includes every clip, effect, text " +
      "overlay, transition and the audio mix. Returns the output file's server path plus a " +
      "URL, and a local copy when downloadTo is given. Requires the export worker to be " +
      "running.",
    inputSchema: {
      projectId: z.string().describe("Project id to export."),
      downloadTo: z
        .string()
        .optional()
        .describe("Optional local directory to save the finished MP4 into."),
    },
  },
  async ({ projectId, downloadTo }) => {
    try {
      const queued = await service.startExport(projectId, {});
      const job = await service.waitForJob(() => service.exportStatus(queued.jobId), {
        timeoutMs: 30 * 60_000,
        intervalMs: 3000,
        label: `Export of project ${projectId}`,
      });

      let saved = null;
      if (downloadTo) {
        saved = await service.downloadToFile(job.url, path.join(downloadTo, job.file));
      }

      return ok(
        `Exported ${job.file} (${job.bytes} bytes, took ${job.durationSeconds}s).`,
        {
          file: job.file,
          bytes: job.bytes,
          serverPath: job.filePath,
          serviceUrl: `${SERVICE_URL}${job.url}`,
          localPath: saved?.path ?? null,
          exportSeconds: job.durationSeconds,
        },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "render_preview_frame",
  {
    title: "Look at one frame",
    description:
      "Renders a single frame of the project as a PNG and waits for it (a few seconds - far " +
      "cheaper than export_project, which encodes the whole timeline). Use it to CHECK YOUR " +
      "WORK: after laying out clips, render a frame at a time where an overlay or effect " +
      "should be visible and confirm it is. It runs the editor's own compositing path, so " +
      "what you see is what an export would produce at that instant - tracks in order, " +
      "transforms, effects, text and graphics - minus audio. Saves to downloadTo when given.",
    inputSchema: {
      projectId: z.string().describe("Project id to render from."),
      time: z
        .number()
        .min(0)
        .describe("Timeline position in seconds. Clamped to the timeline's duration."),
      width: z.number().int().positive().optional().describe("Optional output width; defaults to the project's."),
      height: z.number().int().positive().optional().describe("Optional output height."),
      downloadTo: z.string().optional().describe("Optional local directory to save the PNG into."),
    },
  },
  async ({ projectId, time, width, height, downloadTo }) => {
    try {
      const queued = await service.startFrame(projectId, { time, width, height });
      const job = await service.waitForJob(() => service.exportStatus(queued.jobId), {
        timeoutMs: 5 * 60_000,
        intervalMs: 1000,
        label: `Preview frame of project ${projectId} at ${time}s`,
      });

      let saved = null;
      if (downloadTo) {
        saved = await service.downloadToFile(job.url, path.join(downloadTo, job.file));
      }

      return ok(
        `Rendered a frame at ${job.time ?? time}s (${job.width}x${job.height}, ${job.bytes} bytes).`,
        {
          file: job.file,
          time: job.time ?? time,
          width: job.width,
          height: job.height,
          bytes: job.bytes,
          serverPath: job.filePath,
          serviceUrl: `${SERVICE_URL}${job.url}`,
          localPath: saved?.path ?? null,
        },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "service_health",
  {
    title: "Check the editor services",
    description:
      "Checks that render-service is reachable and Redis is up. Call this first if another " +
      "tool fails with a connection error, to tell a stopped service apart from a bad request.",
    inputSchema: {},
  },
  async () => {
    try {
      const health = await service.health();
      return ok(`Service ${health.status}, redis ${health.redis}.`, { serviceUrl: SERVICE_URL, ...health });
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the protocol channel — anything human-readable must go to stderr.
process.stderr.write(`[video-editor-mcp] connected, service ${SERVICE_URL}\n`);
