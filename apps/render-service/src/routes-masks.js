import { randomUUID } from "node:crypto";

import {
  maskPathToSvgD,
  refitMaskPath,
} from "../../editor/packages/core/src/video/mask-library.js";
import {
  parseSvgToMaskPath,
  SvgMaskImportError,
} from "../../editor/packages/core/src/video/svg-mask-path.js";

import {
  createSavedMask,
  deleteSavedMask,
  getProject,
  getSavedMask,
  getSavedMaskByName,
  listSavedMasks,
  SavedMaskNameTakenError,
} from "./db.js";

/**
 * The saved-mask library: named mask shapes, reusable on any clip in any project.
 *
 * Entries are saved explicitly - importing an SVG for one clip never adds one. Applying an
 * entry COPIES its path onto the clip, re-fitted to that project's frame, and the clip keeps
 * no reference back here: deleting an entry therefore cannot change a clip that already has
 * it. The same geometry module re-fits in the editor, so a person and an agent applying the
 * same entry get the same mask.
 *
 * No rename: delete and save again covers it, and unique names make adding it later easy.
 *
 * NO AUTHENTICATION, like every other route here - localhost only. See NOTES.md.
 */

const MAX_NAME_LENGTH = 120;

/** A 400 with a machine-readable code, thrown from helpers and turned into a reply once. */
class MaskRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireName(name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new MaskRequestError(400, "INVALID_PARAMS", "name is required");
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new MaskRequestError(400, "INVALID_PARAMS", `name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function finitePoint(point, where) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    throw new MaskRequestError(400, "INVALID_PARAMS", `${where} must have finite x and y`);
  }
  return { x: Number(point.x), y: Number(point.y) };
}

/**
 * Checks a posted path and rebuilds it from known fields only, so nothing unexpected is
 * stored. Two anchors are allowed when a curve joins them (a lens); a straight two-point
 * path encloses nothing - the same rule the SVG parser applies.
 */
function normalizePath(path) {
  if (!path || !Array.isArray(path.points)) {
    throw new MaskRequestError(400, "INVALID_PARAMS", "path.points must be an array");
  }
  const points = path.points.map((point, index) => {
    const out = finitePoint(point, `path.points[${index}]`);
    if (point.handleIn) out.handleIn = finitePoint(point.handleIn, `path.points[${index}].handleIn`);
    if (point.handleOut) out.handleOut = finitePoint(point.handleOut, `path.points[${index}].handleOut`);
    return out;
  });
  const curved = points.some((point) => point.handleIn || point.handleOut);
  if (points.length < 2 || (points.length < 3 && !curved)) {
    throw new MaskRequestError(400, "INVALID_PARAMS", "path needs at least 3 points (or 2 joined by a curve)");
  }
  return { points, closed: true };
}

function requireFrame(width, height, what) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new MaskRequestError(
      400,
      "INVALID_PARAMS",
      `${what} needs sourceWidth and sourceHeight: the frame size the mask was made in`,
    );
  }
  return { width: w, height: h };
}

/**
 * Works out what to store from one of three kinds of request:
 *   { path, sourceWidth, sourceHeight }   - a shape the caller already has
 *   { svg }                               - parsed here; its own viewBox is the frame
 *   { projectId, clipId, maskId? }        - a clip's current mask, in its project's frame
 */
function resolveSource(body) {
  const kinds = ["path", "svg", "projectId"].filter((key) => body[key] !== undefined);
  if (kinds.length !== 1) {
    throw new MaskRequestError(
      400,
      "INVALID_PARAMS",
      "Give exactly one source: path (with sourceWidth/sourceHeight), svg, or projectId + clipId",
    );
  }

  if (body.path !== undefined) {
    const frame = requireFrame(body.sourceWidth, body.sourceHeight, "A path");
    return {
      path: normalizePath(body.path),
      frame,
      sourceSvg: typeof body.sourceSvg === "string" ? body.sourceSvg : null,
      warnings: [],
    };
  }

  if (body.svg !== undefined) {
    if (typeof body.svg !== "string") {
      throw new MaskRequestError(400, "INVALID_PARAMS", "svg must be a string of SVG markup");
    }
    try {
      // No composition: normalized to the SVG's own box, which then serves as the frame
      // it was "made in". Re-fitting later is then exactly the viewBox fit the editor's
      // importer would have done in the target project.
      const parsed = parseSvgToMaskPath(body.svg);
      return {
        path: parsed.path,
        frame: { width: parsed.box.width, height: parsed.box.height },
        sourceSvg: body.svg,
        warnings: parsed.warnings,
      };
    } catch (error) {
      if (error instanceof SvgMaskImportError) {
        throw new MaskRequestError(400, "INVALID_SVG", error.message);
      }
      throw error;
    }
  }

  const record = getProject(body.projectId);
  if (!record) throw new MaskRequestError(404, "PROJECT_NOT_FOUND", `Project ${body.projectId} not found`);
  if (typeof body.clipId !== "string" || !body.clipId) {
    throw new MaskRequestError(400, "INVALID_PARAMS", "clipId is required with projectId");
  }

  const onClip = (record.project.masks ?? []).filter((mask) => mask.clipId === body.clipId);
  let mask;
  if (body.maskId !== undefined) {
    mask = onClip.find((candidate) => candidate.id === body.maskId);
    if (!mask) {
      throw new MaskRequestError(404, "MASK_NOT_FOUND", `Clip ${body.clipId} has no mask ${body.maskId}`);
    }
  } else if (onClip.length === 1) {
    mask = onClip[0];
  } else if (onClip.length === 0) {
    throw new MaskRequestError(404, "MASK_NOT_FOUND", `Clip ${body.clipId} has no masks`);
  } else {
    throw new MaskRequestError(
      400,
      "AMBIGUOUS_MASK",
      `Clip ${body.clipId} has ${onClip.length} masks; pass maskId, one of: ` +
        onClip.map((candidate) => `${candidate.id} (${candidate.type})`).join(", "),
    );
  }

  if (mask.type === "track-matte") {
    // Its stored path is a full-frame placeholder; the real shape comes from another clip
    // at render time, so there is no shape here to save.
    throw new MaskRequestError(
      400,
      "UNSAVABLE_MASK",
      "Track-matte masks take their shape from another clip at render time, so there is no shape to save",
    );
  }

  const warnings = [];
  if (Array.isArray(mask.keyframes) && mask.keyframes.length > 0) {
    warnings.push("This mask is animated; only its current shape was saved, not its keyframes.");
  }
  return {
    path: normalizePath(mask.path),
    frame: requireFrame(record.project.settings?.width, record.project.settings?.height, "The project"),
    sourceSvg: null,
    warnings,
  };
}

/** What a listing carries per entry: enough for a picker and a thumbnail, no heavy data. */
function summarize(mask) {
  const frame =
    mask.sourceWidth && mask.sourceHeight ? { width: mask.sourceWidth, height: mask.sourceHeight } : null;
  return {
    id: mask.id,
    name: mask.name,
    pointCount: mask.pointCount,
    sourceWidth: mask.sourceWidth,
    sourceHeight: mask.sourceHeight,
    createdAt: mask.createdAt,
    // Pair with viewBox="0 0 sourceWidth sourceHeight".
    previewPath: maskPathToSvgD(mask.path, frame ?? { width: 1, height: 1 }),
  };
}

/**
 * Replaces `savedMaskId` / `savedMaskName` on set_clip_mask ops with plain `points`,
 * re-fitted to the target project's frame.
 *
 * Done here, before project-kit sees the ops, because the library lives in this database
 * and project-kit is pure - which is what lets an ops batch be all-or-nothing. A lookup
 * that fails throws before anything is applied, so nothing is saved.
 *
 * @returns the rewritten ops (the input array is not modified)
 */
export function resolveSavedMaskRefs(ops, project) {
  if (!Array.isArray(ops)) return ops;
  return ops.map((entry, index) => {
    if (!entry || entry.op !== "set_clip_mask") return entry;
    const { savedMaskId, savedMaskName, ...rest } = entry;
    if (savedMaskId === undefined && savedMaskName === undefined) return entry;

    const where = `ops[${index}] (set_clip_mask)`;
    if (savedMaskId !== undefined && savedMaskName !== undefined) {
      throw new MaskRequestError(400, "INVALID_PARAMS", `${where}: pass savedMaskId or savedMaskName, not both`);
    }
    if (rest.svg !== undefined || rest.points !== undefined) {
      throw new MaskRequestError(
        400,
        "INVALID_PARAMS",
        `${where}: a saved mask replaces svg/points - pass only one source`,
      );
    }

    const saved = savedMaskId !== undefined ? getSavedMask(savedMaskId) : getSavedMaskByName(String(savedMaskName));
    if (!saved) {
      const known = listSavedMasks().map((mask) => `"${mask.name}"`).join(", ") || "none";
      throw new MaskRequestError(
        400,
        "SAVED_MASK_NOT_FOUND",
        `${where}: no saved mask ${savedMaskId !== undefined ? `with id ${savedMaskId}` : `named "${savedMaskName}"`}. Saved masks: ${known}`,
      );
    }

    const from = saved.sourceWidth && saved.sourceHeight ? { width: saved.sourceWidth, height: saved.sourceHeight } : null;
    const to = project?.settings ? { width: project.settings.width, height: project.settings.height } : null;
    // A fresh copy every time: the clip must never share the library's object.
    return { ...rest, points: refitMaskPath(saved.path, from, to).points };
  });
}

export { MaskRequestError };

export async function registerMaskRoutes(app) {
  const send = (reply, error) => {
    if (error instanceof MaskRequestError) {
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    if (error instanceof SavedMaskNameTakenError) {
      return reply.code(409).send({ error: error.message, code: "NAME_TAKEN" });
    }
    throw error;
  };

  app.get("/masks", async () => ({ masks: listSavedMasks().map(summarize) }));

  app.get("/masks/:id", async (request, reply) => {
    const mask = getSavedMask(request.params.id);
    if (!mask) return reply.code(404).send({ error: "Unknown saved mask", code: "SAVED_MASK_NOT_FOUND" });
    return mask;
  });

  app.post("/masks", async (request, reply) => {
    try {
      const body = request.body ?? {};
      const name = requireName(body.name);
      const { path, frame, sourceSvg, warnings } = resolveSource(body);
      const saved = createSavedMask({
        id: randomUUID(),
        name,
        path,
        sourceWidth: frame.width,
        sourceHeight: frame.height,
        sourceSvg,
      });
      return reply.code(201).send({ ...summarize(saved), warnings });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.delete("/masks/:id", async (request, reply) => {
    // Clips that already use this shape hold their own copy of it and are untouched.
    if (!deleteSavedMask(request.params.id)) {
      return reply.code(404).send({ error: "Unknown saved mask", code: "SAVED_MASK_NOT_FOUND" });
    }
    return { deleted: request.params.id };
  });
}
