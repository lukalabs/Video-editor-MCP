/**
 * Converts a single-path SVG into the BezierPath the mask engine draws.
 *
 * Deliberately plain JavaScript with a hand-written .d.ts beside it. The editor is a
 * TypeScript/Vite workspace while project-kit, render-service and the MCP server are plain
 * Node ESM in a separate dependency universe that imports by relative path - a .ts module
 * is unreachable from there without a build step. Keeping this one file JavaScript is what
 * lets the UI and the ops layer share the *same* parser rather than two that drift.
 *
 * No DOM: this runs both in a browser tab and in a Node process, so it cannot reach for
 * DOMParser or document.createElementNS.
 *
 * Coordinates come out normalized 0..1 of the composition, which is what MaskEngine
 * multiplies by the canvas size at draw time. Bezier handles are absolute normalized
 * points (not deltas from their anchor), matching the renderer: handleOut of a point is
 * the first control point of the segment leaving it, handleIn of the next point the
 * second. A segment with no handles renders straight, so lines need no special case.
 */

/** Raised for anything we refuse to import. The message is shown to the user as-is. */
export class SvgMaskImportError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = "SvgMaskImportError";
    this.code = code;
  }
}

/** Elements that carry geometry we would have to flatten. Deliberately not flattened. */
const SHAPE_ELEMENTS = [
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "line",
  "use",
  "text",
  "image",
];

/** Anchors closer than this (in normalized units) are treated as the same point. */
const EPSILON = 1e-6;

/** Strips comments, CDATA and non-drawable blocks so counting only sees real content. */
function stripNonDrawable(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<defs[\s\S]*?<\/defs>/gi, "")
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}

/** Counts occurrences of an element, tolerating both <tag ...> and <tag/>. */
function countElement(svg, tag) {
  const matches = svg.match(new RegExp("<" + tag + "(?=[\\s/>])", "gi"));
  return matches ? matches.length : 0;
}

/**
 * Rejects anything that is not exactly one <path>, naming what it actually found.
 *
 * We do not auto-flatten groups or shape primitives: silently merging a multi-layer file
 * into one mask produces a shape nobody asked for, and the user cannot tell what was lost.
 */
function assertSinglePath(svg) {
  const pathCount = countElement(svg, "path");
  const groupCount = countElement(svg, "g");
  /** @type {string[]} */
  const found = [];

  if (pathCount !== 1) found.push(pathCount + " path" + (pathCount === 1 ? "" : "s"));
  if (groupCount > 0) found.push(groupCount + " group" + (groupCount === 1 ? "" : "s"));

  for (const tag of SHAPE_ELEMENTS) {
    const count = countElement(svg, tag);
    if (count > 0) {
      found.push(count + " <" + tag + ">" + (count === 1 ? " element" : " elements"));
    }
  }

  if (found.length > 0) {
    throw new SvgMaskImportError(
      "Only single-path SVGs are supported - this file has " +
        found.join(" and ") +
        ". Flatten or combine it into one path in your design tool and export again.",
      "NOT_SINGLE_PATH",
    );
  }
}

/** Pulls an attribute off the first occurrence of an element. */
function attribute(svg, tag, name) {
  const element = new RegExp("<" + tag + "\\b[^>]*>", "i").exec(svg);
  if (!element) return null;
  const pattern = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i");
  const match = pattern.exec(element[0]);
  if (!match) return null;
  return match[2] !== undefined ? match[2] : match[3];
}

/** Parses "0 0 100 100" (commas or whitespace) into a box. */
function parseViewBox(value) {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** Strips a unit suffix from width="1080px". Percentages are not a usable box. */
function parseLength(value) {
  if (!value) return null;
  const match = /^\s*(-?[\d.]+)\s*(px|pt|mm|cm|in)?\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Splits a path's `d` into commands with their numeric arguments.
 *
 * Handles the compact forms real exporters emit: implicit repeated commands
 * ("L10,10 20,20"), no separator before a minus ("10-5"), exponents and leading dots.
 */
function tokenize(d) {
  /** @type {{ command: string, args: number[] }[]} */
  const out = [];
  const token = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
  let current = null;
  let match;

  while ((match = token.exec(d)) !== null) {
    if (match[1]) {
      current = { command: match[1], args: [] };
      out.push(current);
    } else {
      if (!current) {
        throw new SvgMaskImportError(
          "The path data starts with a number instead of a command.",
          "BAD_PATH_DATA",
        );
      }
      current.args.push(Number(match[2]));
    }
  }
  return out;
}

/** Quadratic control point raised to the two cubic ones. Exact, not sampled. */
function quadraticToCubic(p0, q, p1) {
  return {
    cp1: { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
    cp2: { x: p1.x + (2 / 3) * (q.x - p1.x), y: p1.y + (2 / 3) * (q.y - p1.y) },
  };
}

/**
 * Walks the commands, producing anchors in the SVG's own user space.
 *
 * Normalization happens afterwards so the bounding-box fallback can measure the real
 * geometry first.
 */
function buildAnchors(commands) {
  /** @type {any[]} */
  const anchors = [];
  /** @type {string[]} */
  const warnings = [];
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  /** Control points of the previous curve, for the S and T reflections. */
  let lastCubicControl = null;
  let lastQuadraticControl = null;
  let sawMove = false;
  let closed = false;

  const push = (point) => {
    anchors.push({ x: point.x, y: point.y });
  };

  /** Attaches a cubic segment from the last anchor to `to`. */
  const curveTo = (cp1, cp2, to) => {
    if (anchors.length === 0) push(current);
    anchors[anchors.length - 1].handleOut = { x: cp1.x, y: cp1.y };
    push(to);
    anchors[anchors.length - 1].handleIn = { x: cp2.x, y: cp2.y };
  };

  for (const { command, args } of commands) {
    const upper = command.toUpperCase();
    const relative = command !== upper;

    if (upper === "A") {
      throw new SvgMaskImportError(
        "This path uses elliptical arc commands (A), which are not supported. " +
          "Re-export it with arcs converted to curves and try again.",
        "UNSUPPORTED_ARC",
      );
    }

    if (upper === "Z") {
      closed = true;
      current = { x: start.x, y: start.y };
      lastCubicControl = null;
      lastQuadraticControl = null;
      continue;
    }

    if (upper === "M") {
      if (args.length < 2) {
        throw new SvgMaskImportError(
          "A moveto command is missing its coordinates.",
          "BAD_PATH_DATA",
        );
      }
      if (sawMove && anchors.length > 0) {
        throw new SvgMaskImportError(
          "This path contains more than one subpath (a shape with a hole, or several " +
            "separate outlines). Only a single continuous outline can be imported as a mask.",
          "MULTIPLE_SUBPATHS",
        );
      }
      current = relative
        ? { x: current.x + args[0], y: current.y + args[1] }
        : { x: args[0], y: args[1] };
      start = { x: current.x, y: current.y };
      sawMove = true;
      push(current);
      // Any extra coordinate pairs on a moveto are implicit linetos.
      for (let i = 2; i + 1 < args.length; i += 2) {
        current = relative
          ? { x: current.x + args[i], y: current.y + args[i + 1] }
          : { x: args[i], y: args[i + 1] };
        push(current);
      }
      lastCubicControl = null;
      lastQuadraticControl = null;
      continue;
    }

    if (!sawMove) {
      throw new SvgMaskImportError(
        "The path data does not start with a moveto (M) command.",
        "BAD_PATH_DATA",
      );
    }

    if (upper === "L") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        current = relative
          ? { x: current.x + args[i], y: current.y + args[i + 1] }
          : { x: args[i], y: args[i + 1] };
        push(current);
      }
      lastCubicControl = null;
      lastQuadraticControl = null;
    } else if (upper === "H") {
      for (const arg of args) {
        current = { x: relative ? current.x + arg : arg, y: current.y };
        push(current);
      }
      lastCubicControl = null;
      lastQuadraticControl = null;
    } else if (upper === "V") {
      for (const arg of args) {
        current = { x: current.x, y: relative ? current.y + arg : arg };
        push(current);
      }
      lastCubicControl = null;
      lastQuadraticControl = null;
    } else if (upper === "C") {
      for (let i = 0; i + 5 < args.length; i += 6) {
        const base = relative ? current : { x: 0, y: 0 };
        const cp1 = { x: base.x + args[i], y: base.y + args[i + 1] };
        const cp2 = { x: base.x + args[i + 2], y: base.y + args[i + 3] };
        const to = { x: base.x + args[i + 4], y: base.y + args[i + 5] };
        curveTo(cp1, cp2, to);
        current = to;
        lastCubicControl = cp2;
        lastQuadraticControl = null;
      }
    } else if (upper === "S") {
      for (let i = 0; i + 3 < args.length; i += 4) {
        const base = relative ? current : { x: 0, y: 0 };
        const cp1 = lastCubicControl
          ? { x: 2 * current.x - lastCubicControl.x, y: 2 * current.y - lastCubicControl.y }
          : { x: current.x, y: current.y };
        const cp2 = { x: base.x + args[i], y: base.y + args[i + 1] };
        const to = { x: base.x + args[i + 2], y: base.y + args[i + 3] };
        curveTo(cp1, cp2, to);
        current = to;
        lastCubicControl = cp2;
        lastQuadraticControl = null;
      }
    } else if (upper === "Q") {
      for (let i = 0; i + 3 < args.length; i += 4) {
        const base = relative ? current : { x: 0, y: 0 };
        const q = { x: base.x + args[i], y: base.y + args[i + 1] };
        const to = { x: base.x + args[i + 2], y: base.y + args[i + 3] };
        const { cp1, cp2 } = quadraticToCubic(current, q, to);
        curveTo(cp1, cp2, to);
        current = to;
        lastQuadraticControl = q;
        lastCubicControl = cp2;
      }
    } else if (upper === "T") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const base = relative ? current : { x: 0, y: 0 };
        const q = lastQuadraticControl
          ? { x: 2 * current.x - lastQuadraticControl.x, y: 2 * current.y - lastQuadraticControl.y }
          : { x: current.x, y: current.y };
        const to = { x: base.x + args[i], y: base.y + args[i + 1] };
        const { cp1, cp2 } = quadraticToCubic(current, q, to);
        curveTo(cp1, cp2, to);
        current = to;
        lastQuadraticControl = q;
        lastCubicControl = cp2;
      }
    } else {
      warnings.push('Ignored unsupported path command "' + command + '".');
    }
  }

  return { anchors, warnings, closed };
}

/** The tightest box containing every anchor and control point. */
function boundingBox(anchors) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const anchor of anchors) {
    for (const point of [anchor, anchor.handleIn, anchor.handleOut]) {
      if (!point) continue;
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }

  if (!Number.isFinite(minX)) return null;
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1e-9),
    height: Math.max(maxY - minY, 1e-9),
  };
}

/**
 * Parses a single-path SVG into a normalized BezierPath.
 *
 * @param {string} svg Raw SVG markup.
 * @param {{ compositionWidth?: number, compositionHeight?: number }} [options]
 *   The composition's pixel dimensions. Supplying them keeps the shape's proportions: the
 *   artwork is fitted (letterboxed) inside the frame and centred, so a circle stays a
 *   circle in a 9:16 project. Without them the SVG box is stretched onto the unit square.
 * @returns {{ path: { points: any[], closed: boolean }, warnings: string[], box: { x: number, y: number, width: number, height: number } }}
 */
export function parseSvgToMaskPath(svg, options = {}) {
  if (typeof svg !== "string" || svg.trim() === "") {
    throw new SvgMaskImportError("The file is empty.", "EMPTY");
  }
  if (!/<svg[\s>]/i.test(svg)) {
    throw new SvgMaskImportError("This does not look like an SVG file.", "NOT_SVG");
  }

  const cleaned = stripNonDrawable(svg);
  assertSinglePath(cleaned);

  const pathElement = /<path\b[^>]*>/i.exec(cleaned);
  if (pathElement && /\btransform\s*=/i.test(pathElement[0])) {
    throw new SvgMaskImportError(
      "The path carries a transform attribute, which is not applied on import. " +
        "Flatten the transform in your design tool and export again.",
      "UNSUPPORTED_TRANSFORM",
    );
  }

  const d = attribute(cleaned, "path", "d");
  if (!d || d.trim() === "") {
    throw new SvgMaskImportError(
      "The path has no shape data (its `d` attribute is empty).",
      "BAD_PATH_DATA",
    );
  }

  const { anchors, warnings, closed } = buildAnchors(tokenize(d));
  if (anchors.length < 2) {
    throw new SvgMaskImportError(
      "The path has fewer than two points, so it encloses no area.",
      "DEGENERATE",
    );
  }

  // The user-space box we map from: the viewBox is authoritative, width/height is the
  // usual fallback, and the path's own bounds are the last resort for a bare <path>.
  const viewBox = parseViewBox(attribute(cleaned, "svg", "viewBox"));
  const width = parseLength(attribute(cleaned, "svg", "width"));
  const height = parseLength(attribute(cleaned, "svg", "height"));
  let box = viewBox;
  if (!box && width && height) box = { x: 0, y: 0, width, height };
  if (!box) {
    box = boundingBox(anchors);
    warnings.push("The SVG has no viewBox or size, so the shape was fitted to its own bounds.");
  }

  // Fit, not stretch: a mask usually carries a meaningful silhouette and squashing it
  // defeats the point of importing that exact shape.
  const compositionWidth = options.compositionWidth;
  const compositionHeight = options.compositionHeight;
  let scaleX;
  let scaleY;
  let offsetX;
  let offsetY;

  if (compositionWidth && compositionHeight) {
    const scale = Math.min(compositionWidth / box.width, compositionHeight / box.height);
    const drawnWidth = box.width * scale;
    const drawnHeight = box.height * scale;
    scaleX = scale / compositionWidth;
    scaleY = scale / compositionHeight;
    offsetX = (compositionWidth - drawnWidth) / 2 / compositionWidth;
    offsetY = (compositionHeight - drawnHeight) / 2 / compositionHeight;
  } else {
    scaleX = 1 / box.width;
    scaleY = 1 / box.height;
    offsetX = 0;
    offsetY = 0;
  }

  const project = (point) => ({
    x: offsetX + (point.x - box.x) * scaleX,
    y: offsetY + (point.y - box.y) * scaleY,
  });

  const points = anchors.map((anchor) => {
    /** @type {any} */
    const out = project(anchor);
    if (anchor.handleIn) out.handleIn = project(anchor.handleIn);
    if (anchor.handleOut) out.handleOut = project(anchor.handleOut);
    return out;
  });

  // Exporters usually end a closed shape on the point it started from. The renderer
  // closes the path itself, so the duplicate would leave a zero-length segment - drop it,
  // keeping the incoming handle that belongs to the closing curve.
  if (points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) < EPSILON && Math.abs(first.y - last.y) < EPSILON) {
      if (last.handleIn) first.handleIn = last.handleIn;
      points.pop();
    }
  }

  // Two anchors still enclose an area when they are joined by curves, because the
  // renderer wraps around: a lens or teardrop is two points and four handles. Only a
  // straight two-point path is genuinely a line with nothing inside it.
  const hasCurve = points.some((point) => point.handleIn || point.handleOut);
  if (points.length < 3 && !hasCurve) {
    throw new SvgMaskImportError(
      "The path is a straight line, so it encloses no area.",
      "DEGENERATE",
    );
  }

  // The mask renderer always closes the outline, so an unclosed path would render as a
  // filled shape anyway - recording it as closed keeps the stored data honest.
  // `box` is the user-space rectangle the path was mapped from. Callers that save the
  // shape without a composition use it as the frame the mask was made in.
  return {
    path: { points, closed: true },
    warnings,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
}
