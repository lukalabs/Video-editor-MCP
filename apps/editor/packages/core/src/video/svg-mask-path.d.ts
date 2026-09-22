import type { BezierPath } from "./mask-engine";

/**
 * Types for the plain-JavaScript SVG mask parser.
 *
 * The implementation is JavaScript on purpose so the Node-side ops layer (project-kit,
 * render-service, the MCP server) can import the very same file the editor does - see the
 * header of svg-mask-path.js. These declarations give the TypeScript side real types over it.
 */

/** Why an SVG was refused. Each maps to a message written for the person importing. */
export type SvgMaskImportErrorCode =
  | "EMPTY"
  | "NOT_SVG"
  | "NOT_SINGLE_PATH"
  | "UNSUPPORTED_TRANSFORM"
  | "UNSUPPORTED_ARC"
  | "MULTIPLE_SUBPATHS"
  | "BAD_PATH_DATA"
  | "DEGENERATE";

export declare class SvgMaskImportError extends Error {
  readonly code: SvgMaskImportErrorCode;
  constructor(message: string, code: SvgMaskImportErrorCode);
}

export interface SvgMaskParseOptions {
  /**
   * Composition dimensions in pixels. Supplying both fits the artwork inside the frame
   * with its aspect ratio preserved and centred; omitting them stretches the SVG's box
   * onto the unit square.
   */
  compositionWidth?: number;
  compositionHeight?: number;
}

export interface SvgMaskParseResult {
  /** Normalized 0..1 path, ready for `createDrawnMask`. */
  path: BezierPath;
  /** Non-fatal notes worth showing, e.g. a missing viewBox. */
  warnings: string[];
}

/**
 * Parses a single-path SVG into a normalized BezierPath.
 *
 * @throws {SvgMaskImportError} for multi-path or multi-layer files, arcs, transforms,
 * multiple subpaths, and malformed or degenerate path data.
 */
export declare function parseSvgToMaskPath(
  svg: string,
  options?: SvgMaskParseOptions,
): SvgMaskParseResult;
