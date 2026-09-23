import type { BezierPath } from "./mask-engine";

/**
 * Types for the plain-JavaScript saved-mask geometry. See the header of mask-library.js
 * for why it is JavaScript.
 */

export interface MaskFrame {
  width: number;
  height: number;
}

/**
 * Moves a mask from the frame it was made in onto a differently shaped one, keeping its
 * proportions and its place in the frame. Always returns a fresh copy.
 */
export declare function refitMaskPath(
  path: BezierPath,
  from: MaskFrame | null | undefined,
  to: MaskFrame | null | undefined,
): BezierPath;

/** An SVG `d` outline in the frame's pixel space, for `viewBox="0 0 width height"`. */
export declare function maskPathToSvgD(path: Pick<BezierPath, "points">, frame: MaskFrame): string;
