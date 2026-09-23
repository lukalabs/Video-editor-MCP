/**
 * The mask ops, and - the point of the exercise - the fact that they go through the
 * editor's own SVG parser rather than a second copy of it.
 *
 * A mask imported by an agent has to land in exactly the same shape the UI would have
 * produced, because both end up in the same `project.masks` array that preview and export
 * read. Two parsers that agree today drift tomorrow, and this project has paid for that
 * kind of divergence more than once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addClip,
  addMediaItem,
  addTrack,
  applyOps,
  createProject,
  ProjectKitError,
  removeClipMask,
  setClipMask,
} from "../src/index.js";
import { parseSvgToMaskPath } from "../../../apps/editor/packages/core/src/video/svg-mask-path.js";

const SQUARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M25 25 L75 25 L75 75 L25 75 Z"/>
</svg>`;

/** A project with one clip, which is all a mask needs to attach to. */
function projectWithClip({ width = 1920, height = 1080 } = {}) {
  let project = createProject({ name: "Masks", width, height });
  const trackId = project.timeline.tracks[0].id;
  project = addMediaItem(project, {
    id: "m1",
    name: "shot.mp4",
    metadata: {
      duration: 10,
      width: 1920,
      height: 1080,
      frameRate: 30,
      codec: "h264",
      hasVideo: true,
      hasAudio: true,
    },
  }).project;
  const added = addClip(project, { trackId, mediaId: "m1", startTime: 0, duration: 5 });
  return { project: added.project, clipId: added.clipId, trackId };
}

test("imports an SVG into project.masks as a drawn mask", () => {
  const { project, clipId } = projectWithClip();

  const result = setClipMask(project, { clipId, svg: SQUARE_SVG });

  assert.equal(result.project.masks.length, 1);
  const mask = result.project.masks[0];
  assert.equal(mask.clipId, clipId);
  assert.equal(mask.type, "drawn");
  assert.equal(mask.path.closed, true);
  assert.equal(mask.path.points.length, 4);
  assert.equal(result.pointCount, 4);
  // Defaults match createDrawnMask in the editor, so an imported mask behaves the same.
  assert.equal(mask.feathering, 0);
  assert.equal(mask.inverted, false);
  assert.equal(mask.expansion, 0);
  assert.equal(mask.opacity, 1);
  assert.deepEqual(mask.keyframes, []);
});

test("produces exactly what the shared parser produces, not a re-implementation", () => {
  const { project, clipId } = projectWithClip({ width: 1080, height: 1920 });

  const viaOp = setClipMask(project, { clipId, svg: SQUARE_SVG }).project.masks[0].path;
  const viaParser = parseSvgToMaskPath(SQUARE_SVG, {
    compositionWidth: 1080,
    compositionHeight: 1920,
  }).path;

  assert.deepEqual(viaOp, viaParser);
});

test("fits the shape to the composition instead of stretching it", () => {
  const { project, clipId } = projectWithClip({ width: 1080, height: 1920 });

  const points = setClipMask(project, { clipId, svg: SQUARE_SVG }).project.masks[0].path.points;

  // The square occupies half the 100-unit viewBox. Fitted into a 9:16 frame it keeps its
  // proportions, so its normalized height is smaller than its normalized width.
  const width = points[1].x - points[0].x;
  const height = points[2].y - points[1].y;
  assert.ok(Math.abs(width - 0.5) < 1e-9, `expected half-width, got ${width}`);
  assert.ok(Math.abs(height - 0.5 * (1080 / 1920)) < 1e-9, `expected fitted height, got ${height}`);
});

test("accepts raw path points for an agent that already has geometry", () => {
  const { project, clipId } = projectWithClip();

  const result = setClipMask(project, {
    clipId,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.5, y: 0.9 },
    ],
  });

  assert.equal(result.project.masks[0].path.points.length, 3);
  assert.deepEqual(result.project.masks[0].path.points[2], { x: 0.5, y: 0.9 });
});

test("keeps bezier handles given as raw points", () => {
  const { project, clipId } = projectWithClip();

  const result = setClipMask(project, {
    clipId,
    points: [
      { x: 0.1, y: 0.1, handleOut: { x: 0.3, y: 0.05 } },
      { x: 0.9, y: 0.1, handleIn: { x: 0.7, y: 0.05 } },
      { x: 0.5, y: 0.9 },
    ],
  });

  assert.deepEqual(result.project.masks[0].path.points[0].handleOut, { x: 0.3, y: 0.05 });
});

test("carries the optional mask properties through", () => {
  const { project, clipId } = projectWithClip();

  const mask = setClipMask(project, {
    clipId,
    svg: SQUARE_SVG,
    feather: 12,
    expansion: -4,
    inverted: true,
    opacity: 0.5,
  }).project.masks[0];

  assert.equal(mask.feathering, 12);
  assert.equal(mask.expansion, -4);
  assert.equal(mask.inverted, true);
  assert.equal(mask.opacity, 0.5);
});

test("adds alongside existing masks, and replaces only when asked", () => {
  const { project, clipId } = projectWithClip();

  const first = setClipMask(project, { clipId, svg: SQUARE_SVG }).project;
  const second = setClipMask(first, { clipId, svg: SQUARE_SVG }).project;
  assert.equal(second.masks.length, 2);

  const replaced = setClipMask(second, { clipId, svg: SQUARE_SVG, replace: true }).project;
  assert.equal(replaced.masks.length, 1);
});

test("replace leaves other clips' masks alone", () => {
  const { project, clipId, trackId } = projectWithClip();
  const other = addClip(project, { trackId, mediaId: "m1", startTime: 6, duration: 3 });

  let current = setClipMask(other.project, { clipId: other.clipId, svg: SQUARE_SVG }).project;
  current = setClipMask(current, { clipId, svg: SQUARE_SVG, replace: true }).project;

  assert.equal(current.masks.length, 2);
  assert.equal(current.masks.filter((mask) => mask.clipId === other.clipId).length, 1);
});

test("removes every mask on a clip", () => {
  const { project, clipId } = projectWithClip();
  const withMasks = setClipMask(
    setClipMask(project, { clipId, svg: SQUARE_SVG }).project,
    { clipId, svg: SQUARE_SVG },
  ).project;

  const result = removeClipMask(withMasks, { clipId });

  assert.equal(result.removed, 2);
  assert.equal(result.project.masks.length, 0);
});

test("rejects a multi-path SVG without touching the project", () => {
  const { project, clipId } = projectWithClip();
  const multi = `<svg viewBox="0 0 100 100">
    <path d="M0 0 L10 0 L10 10 Z"/>
    <path d="M20 20 L30 20 L30 30 Z"/>
  </svg>`;

  assert.throws(
    () => setClipMask(project, { clipId, svg: multi }),
    (error) => error instanceof ProjectKitError && error.code === "INVALID_SVG" && /2 paths/.test(error.message),
  );
  // Nothing partially applied: the caller still holds its original project.
  assert.equal(project.masks, undefined);
});

test("rejects an unknown clip", () => {
  const { project } = projectWithClip();
  assert.throws(
    () => setClipMask(project, { clipId: "nope", svg: SQUARE_SVG }),
    (error) => error.code === "CLIP_NOT_FOUND",
  );
});

test("rejects giving both an SVG and points, or neither", () => {
  const { project, clipId } = projectWithClip();
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ];

  assert.throws(
    () => setClipMask(project, { clipId, svg: SQUARE_SVG, points }),
    (error) => /exactly one of svg or points/.test(error.message),
  );
  assert.throws(
    () => setClipMask(project, { clipId }),
    (error) => /exactly one of svg or points/.test(error.message),
  );
});

test("rejects too few points to enclose an area", () => {
  const { project, clipId } = projectWithClip();
  assert.throws(
    () => setClipMask(project, { clipId, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    (error) => /at least 3/.test(error.message),
  );
});

test("rejects a non-finite coordinate", () => {
  const { project, clipId } = projectWithClip();
  assert.throws(
    () =>
      setClipMask(project, {
        clipId,
        points: [{ x: 0, y: 0 }, { x: "wide", y: 0 }, { x: 1, y: 1 }],
      }),
    (error) => /must be a finite number/.test(error.message),
  );
});

test("runs through applyOps, so an agent can chain it", () => {
  const { project, clipId } = projectWithClip();

  const { project: updated, results } = applyOps(project, [
    { op: "set_clip_mask", clipId, svg: SQUARE_SVG, feather: 8 },
  ]);

  assert.equal(updated.masks.length, 1);
  assert.equal(updated.masks[0].feathering, 8);
  assert.equal(results[0].op, "set_clip_mask");
  assert.ok(results[0].maskId);
});

test("a failing mask op discards the whole batch", () => {
  const { project, clipId } = projectWithClip();

  assert.throws(() =>
    applyOps(project, [
      { op: "add_track", type: "video", name: "Extra" },
      { op: "set_clip_mask", clipId, svg: "<svg><g><path d='M0 0 L1 0 L1 1 Z'/></g></svg>" },
    ]),
  );
  // The track from step one must not survive the failure in step two.
  assert.equal(project.timeline.tracks.length, 1);
});

test("accepts two points joined by a curve, as the SVG parser does", () => {
  // A lens: the renderer wraps around, so two anchors with handles enclose an area. A saved
  // library shape of this kind has to be applicable through points.
  const { project, clipId } = projectWithClip();

  const result = setClipMask(project, {
    clipId,
    points: [
      { x: 0.1, y: 0.5, handleOut: { x: 0.3, y: 0.2 }, handleIn: { x: 0.3, y: 0.8 } },
      { x: 0.9, y: 0.5, handleIn: { x: 0.7, y: 0.2 }, handleOut: { x: 0.7, y: 0.8 } },
    ],
  });

  assert.equal(result.project.masks[0].path.points.length, 2);
});
