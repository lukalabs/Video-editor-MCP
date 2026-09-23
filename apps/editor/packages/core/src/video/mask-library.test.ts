/**
 * The saved-mask re-fit, checked in pixels rather than in normalized numbers.
 *
 * Normalized coordinates hide exactly the bug this exists to prevent: a circle made in a
 * portrait frame looks fine as numbers and comes out as an ellipse in a landscape one. So
 * the assertions convert back to pixels of the target frame and measure the shape there.
 */
import { describe, expect, it } from "vitest";

import { maskPathToSvgD, refitMaskPath } from "./mask-library.js";

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

/** A square made in a portrait frame, full width: 1080px on each side. */
const PORTRAIT_SQUARE = {
  closed: true,
  points: [
    { x: 0, y: 420 / 1920 },
    { x: 1, y: 420 / 1920 },
    { x: 1, y: 1500 / 1920 },
    { x: 0, y: 1500 / 1920 },
  ],
};

function sizeInPixels(path: { points: { x: number; y: number }[] }, frame: typeof PORTRAIT) {
  const xs = path.points.map((p) => p.x * frame.width);
  const ys = path.points.map((p) => p.y * frame.height);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

describe("refitMaskPath", () => {
  it("keeps a square square when moving from portrait to landscape", () => {
    const moved = refitMaskPath(PORTRAIT_SQUARE, PORTRAIT, LANDSCAPE);
    const { width, height } = sizeInPixels(moved, LANDSCAPE);

    expect(width).toBeCloseTo(height, 6);
  });

  it("would have squashed it without the re-fit - the bug this prevents", () => {
    const { width, height } = sizeInPixels(PORTRAIT_SQUARE, LANDSCAPE);
    expect(width / height).toBeGreaterThan(3);
  });

  it("keeps the shape's place in the frame, centred", () => {
    const moved = refitMaskPath(PORTRAIT_SQUARE, PORTRAIT, LANDSCAPE);
    const xs = moved.points.map((p) => p.x);
    const ys = moved.points.map((p) => p.y);

    // Centred in both directions, as the original was.
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0.5, 6);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(0.5, 6);
  });

  it("moves bezier handles with their anchors", () => {
    const path = {
      closed: true,
      points: [
        { x: 0.5, y: 0.25, handleOut: { x: 0.75, y: 0.25 } },
        { x: 0.5, y: 0.75, handleIn: { x: 0.75, y: 0.75 } },
      ],
    };
    const moved = refitMaskPath(path, PORTRAIT, LANDSCAPE);

    // The handle keeps its pixel offset from the anchor in proportion to the anchor's.
    const anchor = moved.points[0];
    const handle = moved.points[0].handleOut!;
    expect(handle.y).toBeCloseTo(anchor.y, 9);
    expect(handle.x).toBeGreaterThan(anchor.x);
  });

  it("is the identity between frames of the same proportions", () => {
    const moved = refitMaskPath(PORTRAIT_SQUARE, PORTRAIT, { width: 540, height: 960 });
    for (let i = 0; i < moved.points.length; i++) {
      expect(moved.points[i].x).toBeCloseTo(PORTRAIT_SQUARE.points[i].x, 9);
      expect(moved.points[i].y).toBeCloseTo(PORTRAIT_SQUARE.points[i].y, 9);
    }
  });

  it("returns a copy, never the object it was given", () => {
    const moved = refitMaskPath(PORTRAIT_SQUARE, PORTRAIT, PORTRAIT);

    expect(moved).not.toBe(PORTRAIT_SQUARE);
    expect(moved.points[0]).not.toBe(PORTRAIT_SQUARE.points[0]);
    moved.points[0].x = 0.9;
    expect(PORTRAIT_SQUARE.points[0].x).toBe(0);
  });

  it("copies unchanged when a frame is unknown", () => {
    const moved = refitMaskPath(PORTRAIT_SQUARE, null, LANDSCAPE);

    expect(moved.points).toEqual(PORTRAIT_SQUARE.points);
    expect(moved.points).not.toBe(PORTRAIT_SQUARE.points);
  });
});

describe("maskPathToSvgD", () => {
  it("draws straight segments as lines and closes the outline", () => {
    const d = maskPathToSvgD(PORTRAIT_SQUARE, PORTRAIT);
    expect(d).toBe("M0 420L1080 420L1080 1500L0 1500L0 420Z");
  });

  it("draws curved segments with the renderer's handle semantics", () => {
    const d = maskPathToSvgD(
      {
        points: [
          { x: 0, y: 0, handleOut: { x: 0.25, y: 0 } },
          { x: 1, y: 1, handleIn: { x: 1, y: 0.75 } },
        ],
      },
      { width: 100, height: 100 },
    );
    expect(d).toBe("M0 0C25 0 100 75 100 100L0 0Z");
  });
});
