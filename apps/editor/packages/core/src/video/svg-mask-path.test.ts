/**
 * The SVG-to-mask parser, checked against the geometry the mask renderer actually draws.
 *
 * The assertions that matter are the coordinate ones: MaskEngine multiplies these numbers
 * by the canvas size, so an off-by-a-factor here is a mask in the wrong place rather than
 * a type error. The rejection tests matter just as much - the brief is to refuse
 * multi-layer files clearly, not to flatten them into a shape nobody drew.
 */
import { describe, expect, it } from "vitest";

import { parseSvgToMaskPath, SvgMaskImportError } from "./svg-mask-path.js";

/** A square, the way an exporter writes one: absolute lines, closed with Z. */
const SQUARE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M25 25 L75 25 L75 75 L25 75 Z" fill="black"/>
</svg>`;

function pointsOf(svg: string, options?: { compositionWidth: number; compositionHeight: number }) {
  return parseSvgToMaskPath(svg, options).path.points;
}

describe("parseSvgToMaskPath", () => {
  it("normalizes coordinates to 0..1 of the viewBox", () => {
    const points = pointsOf(SQUARE);

    expect(points).toHaveLength(4);
    expect(points[0].x).toBeCloseTo(0.25, 6);
    expect(points[0].y).toBeCloseTo(0.25, 6);
    expect(points[2].x).toBeCloseTo(0.75, 6);
    expect(points[2].y).toBeCloseTo(0.75, 6);
  });

  it("leaves straight segments without handles, which the renderer draws as lines", () => {
    for (const point of pointsOf(SQUARE)) {
      expect(point.handleIn).toBeUndefined();
      expect(point.handleOut).toBeUndefined();
    }
  });

  it("reports the path as closed", () => {
    expect(parseSvgToMaskPath(SQUARE).path.closed).toBe(true);
  });

  it("drops the duplicate anchor an exporter leaves on the start point", () => {
    // The final L returns to where M started; the renderer closes the outline itself, so
    // keeping it would leave a zero-length segment.
    const svg = `<svg viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 L10 90 L10 10 Z"/></svg>`;
    expect(pointsOf(svg)).toHaveLength(4);
  });

  it("keeps cubic handles as absolute normalized points", () => {
    const svg = `<svg viewBox="0 0 100 100"><path d="M0 0 C 25 0 100 75 100 100 Z"/></svg>`;
    const points = pointsOf(svg);

    // handleOut of the point a segment leaves is cp1; handleIn of the next point is cp2.
    expect(points[0].handleOut).toEqual({ x: 0.25, y: 0 });
    expect(points[1].handleIn).toEqual({ x: 1, y: 0.75 });
  });

  it("raises a quadratic to the exact cubic rather than sampling it", () => {
    // Q control (50,0) from (0,0) to (100,0): cp1 = p0 + 2/3(q-p0), cp2 = p1 + 2/3(q-p1).
    const svg = `<svg viewBox="0 0 100 100"><path d="M0 0 Q 50 0 100 0 L 100 100 Z"/></svg>`;
    const points = pointsOf(svg);

    expect(points[0].handleOut!.x).toBeCloseTo(1 / 3, 6);
    expect(points[1].handleIn!.x).toBeCloseTo(2 / 3, 6);
  });

  it("understands relative commands, which Figma and Illustrator both emit", () => {
    const absolute = pointsOf(`<svg viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 Z"/></svg>`);
    const relative = pointsOf(`<svg viewBox="0 0 100 100"><path d="m10 10 l80 0 l0 80 z"/></svg>`);

    expect(relative).toEqual(absolute);
  });

  it("expands the H and V shorthands", () => {
    const shorthand = pointsOf(`<svg viewBox="0 0 100 100"><path d="M10 10 H90 V90 Z"/></svg>`);
    const longhand = pointsOf(`<svg viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 Z"/></svg>`);

    expect(shorthand).toEqual(longhand);
  });

  it("reflects the previous control point for S", () => {
    const svg = `<svg viewBox="0 0 100 100"><path d="M0 0 C 20 0 40 0 50 0 S 90 50 100 100 Z"/></svg>`;
    const points = pointsOf(svg);

    // Previous cp2 was (40,0) at anchor (50,0), so the reflection is (60,0).
    expect(points[1].handleOut).toEqual({ x: 0.6, y: 0 });
  });

  it("tolerates the compact number forms exporters emit", () => {
    // No separator before a minus, leading dots, and commas instead of spaces.
    const svg = `<svg viewBox="0 0 100 100"><path d="M50,50L100,50L100,100L50.5,99.5L49-0.5Z"/></svg>`;
    expect(() => parseSvgToMaskPath(svg)).not.toThrow();
    expect(pointsOf(svg).length).toBeGreaterThanOrEqual(4);
  });

  it("falls back to width and height when there is no viewBox", () => {
    const svg = `<svg width="200" height="200"><path d="M50 50 L150 50 L150 150 Z"/></svg>`;
    expect(pointsOf(svg)[0].x).toBeCloseTo(0.25, 6);
  });

  describe("fitting to the composition", () => {
    it("preserves the shape's proportions in a portrait frame", () => {
      // A square viewBox in a 1080x1920 frame: it should stay square, so the normalized
      // width (x of 1080px) must exceed the normalized height (the same 1080px of 1920).
      const points = pointsOf(`<svg viewBox="0 0 100 100"><path d="M0 0 L100 0 L100 100 Z"/></svg>`, {
        compositionWidth: 1080,
        compositionHeight: 1920,
      });

      const widthFraction = points[1].x - points[0].x;
      const heightFraction = points[2].y - points[1].y;
      expect(widthFraction).toBeCloseTo(1, 6);
      expect(heightFraction).toBeCloseTo(1080 / 1920, 6);
    });

    it("centres the fitted shape, leaving equal margins", () => {
      const points = pointsOf(`<svg viewBox="0 0 100 100"><path d="M0 0 L100 0 L100 100 Z"/></svg>`, {
        compositionWidth: 1080,
        compositionHeight: 1920,
      });

      const top = points[0].y;
      const bottom = 1 - points[2].y;
      expect(top).toBeCloseTo(bottom, 6);
      expect(top).toBeGreaterThan(0);
    });

    it("stretches onto the unit square when no composition size is given", () => {
      const points = pointsOf(`<svg viewBox="0 0 100 100"><path d="M0 0 L100 0 L100 100 Z"/></svg>`);
      expect(points[0].y).toBeCloseTo(0, 6);
      expect(points[2].y).toBeCloseTo(1, 6);
    });
  });

  describe("rejections", () => {
    it("refuses a multi-path file and says how many it found", () => {
      const svg = `<svg viewBox="0 0 100 100">
        <path d="M0 0 L10 0 L10 10 Z"/>
        <path d="M20 20 L30 20 L30 30 Z"/>
        <path d="M40 40 L50 40 L50 50 Z"/>
      </svg>`;

      expect(() => parseSvgToMaskPath(svg)).toThrow(SvgMaskImportError);
      expect(() => parseSvgToMaskPath(svg)).toThrow(/3 paths/);
      expect(() => parseSvgToMaskPath(svg)).toThrow(/Only single-path SVGs are supported/);
    });

    it("refuses a grouped file, counting the groups", () => {
      const svg = `<svg viewBox="0 0 100 100"><g><path d="M0 0 L10 0 L10 10 Z"/></g></svg>`;
      expect(() => parseSvgToMaskPath(svg)).toThrow(/1 group/);
    });

    it("refuses shape primitives rather than flattening them", () => {
      const svg = `<svg viewBox="0 0 100 100"><rect x="0" y="0" width="10" height="10"/></svg>`;
      expect(() => parseSvgToMaskPath(svg)).toThrow(/0 paths and 1 <rect> element/);
    });

    it("refuses arcs with a message that says what to do", () => {
      const svg = `<svg viewBox="0 0 100 100"><path d="M0 0 A 50 50 0 0 1 100 100 Z"/></svg>`;
      expect(() => parseSvgToMaskPath(svg)).toThrow(/elliptical arc/i);
    });

    it("refuses a path with several subpaths, such as a shape with a hole", () => {
      const svg = `<svg viewBox="0 0 100 100"><path d="M0 0 L100 0 L100 100 Z M25 25 L75 25 L75 75 Z"/></svg>`;
      expect(() => parseSvgToMaskPath(svg)).toThrow(/more than one subpath/);
    });

    it("refuses a transform instead of silently ignoring it", () => {
      const svg = `<svg viewBox="0 0 100 100"><path transform="translate(10,10)" d="M0 0 L10 0 L10 10 Z"/></svg>`;
      expect(() => parseSvgToMaskPath(svg)).toThrow(/transform/i);
    });

    it("refuses a straight two-point path, which encloses no area", () => {
      const svg = `<svg viewBox="0 0 100 100"><path d="M0 0 L100 100"/></svg>`;
      expect(() => parseSvgToMaskPath(svg)).toThrow(/straight line/);
    });

    it("accepts a two-point path joined by curves, which does enclose an area", () => {
      // A lens: the renderer wraps around, so two anchors and their handles make a shape.
      const svg = `<svg viewBox="0 0 100 100"><path d="M0 50 C 25 0 75 0 100 50 C 75 100 25 100 0 50 Z"/></svg>`;
      expect(pointsOf(svg)).toHaveLength(2);
    });

    it("refuses input that is not an SVG at all", () => {
      expect(() => parseSvgToMaskPath("not markup")).toThrow(/does not look like an SVG/);
      expect(() => parseSvgToMaskPath("")).toThrow(/empty/i);
    });

    it("ignores comments and defs when deciding a file is single-path", () => {
      const svg = `<svg viewBox="0 0 100 100">
        <!-- <path d="M0 0"/> a commented-out path must not count -->
        <defs><path id="unused" d="M0 0 L1 1"/></defs>
        <path d="M25 25 L75 25 L75 75 Z"/>
      </svg>`;

      expect(() => parseSvgToMaskPath(svg)).not.toThrow();
    });
  });
});
