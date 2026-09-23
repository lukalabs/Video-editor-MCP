/**
 * Geometry for the saved-mask library, shared by the editor and the render-service.
 *
 * Plain JavaScript with a .d.ts beside it, for the same reason as svg-mask-path.js: the
 * render-service is plain Node ESM outside the editor's TypeScript workspace, and both
 * sides must re-fit a saved mask identically or the same library entry would land in a
 * different place depending on whether a person or an agent applied it.
 */

/**
 * Deep-copies a path, point by point.
 *
 * Applying a saved mask must copy it onto the clip rather than share it: a clip's mask is
 * a self-contained object in `project.masks`, which is exactly what lets a library entry be
 * deleted without touching any clip that already uses it. `createDrawnMask` keeps whatever
 * object it is handed, so the copy has to happen before that call.
 */
function copyPoint(point) {
  const out = { x: point.x, y: point.y };
  if (point.handleIn) out.handleIn = { x: point.handleIn.x, y: point.handleIn.y };
  if (point.handleOut) out.handleOut = { x: point.handleOut.x, y: point.handleOut.y };
  return out;
}

function isFrame(frame) {
  return (
    frame &&
    Number.isFinite(frame.width) &&
    Number.isFinite(frame.height) &&
    frame.width > 0 &&
    frame.height > 0
  );
}

/**
 * Moves a mask from the frame it was made in onto a differently shaped frame.
 *
 * Mask coordinates are normalized to the frame, so they only mean the same shape in a frame
 * of the same proportions: a circle made in 1080x1920 is stored as 1.0 wide and 0.5625 tall,
 * and read back in 1920x1080 it would come out as a flat ellipse. So the source frame is
 * fitted inside the target - scaled uniformly and centred, the same fit an SVG's viewBox
 * gets on import - which keeps both the shape and its place in the frame. When the two
 * frames have the same proportions this is the identity.
 *
 * Always returns a fresh copy, even when nothing moves.
 *
 * @param {{ points: any[], closed: boolean }} path
 * @param {{ width: number, height: number } | null | undefined} from
 * @param {{ width: number, height: number } | null | undefined} to
 */
export function refitMaskPath(path, from, to) {
  if (!isFrame(from) || !isFrame(to)) {
    return { points: path.points.map(copyPoint), closed: path.closed !== false };
  }

  const scale = Math.min(to.width / from.width, to.height / from.height);
  const offsetX = (to.width - from.width * scale) / 2;
  const offsetY = (to.height - from.height * scale) / 2;

  const move = (point) => ({
    x: (offsetX + point.x * from.width * scale) / to.width,
    y: (offsetY + point.y * from.height * scale) / to.height,
  });

  const points = path.points.map((point) => {
    const out = move(point);
    if (point.handleIn) out.handleIn = move(point.handleIn);
    if (point.handleOut) out.handleOut = move(point.handleOut);
    return out;
  });

  return { points, closed: path.closed !== false };
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * An SVG `d` outline of the path, for thumbnails, in the source frame's pixel space.
 *
 * Pair it with `viewBox="0 0 {width} {height}"` of the frame the mask was made in. Mirrors
 * the mask renderer: segments with no handles are straight, and the outline always closes
 * with the segment from the last point back to the first.
 *
 * @param {{ points: any[] }} path
 * @param {{ width: number, height: number }} frame
 */
export function maskPathToSvgD(path, frame) {
  const points = path.points;
  if (!points || points.length === 0) return "";
  const w = isFrame(frame) ? frame.width : 1;
  const h = isFrame(frame) ? frame.height : 1;
  const px = (p) => round(p.x * w) + " " + round(p.y * h);

  let d = "M" + px(points[0]);
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (current.handleOut || next.handleIn) {
      const cp1 = current.handleOut || current;
      const cp2 = next.handleIn || next;
      d += "C" + px(cp1) + " " + px(cp2) + " " + px(next);
    } else {
      d += "L" + px(next);
    }
  }
  return d + "Z";
}
