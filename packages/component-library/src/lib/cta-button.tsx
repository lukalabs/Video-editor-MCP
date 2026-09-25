/**
 * Shared shell for the CTA button set: text measurement, auto-sizing and the button body.
 *
 * Every `button-*` CTA scene builds its button here and only adds its own look and motion
 * on top, so sizing is decided once. The same reason as balloon-bubble.tsx: a button's
 * width is an input to its geometry, not decoration, and ten copies of that arithmetic
 * would drift apart the first time one of them was tuned.
 *
 * ## Sizing
 *
 * Width is the measured width of the text plus horizontal padding, never below a minimum
 * so a label like "Go" still reads as a button rather than a dot. Height follows the font
 * size: the line height plus vertical padding. Text never clips: past the frame-safe
 * maximum width it wraps (the same greedy, canvas-measured wrap the chat bubbles use) and
 * the button grows taller. A pill always takes half its actual height as its radius.
 *
 * Measurement is text-measure.ts, the one the chat bubbles already use - deliberately not a
 * second implementation. It measures with the exact family, weight, size and tracking the
 * Txt nodes below render with, which is what makes the padding come out even.
 *
 * ## Resting at a known moment
 *
 * Each scene finishes its entrance at `restAt` with the button exactly at rest - scale 1,
 * no rotation, fully drawn - before its idle loop starts. That moment is what the
 * verification measures, and it keeps the ten animations from each inventing their own
 * idea of "the button's real size".
 */
import { Node, Rect, Txt } from "@motion-canvas/2d";
import type { View2D } from "@motion-canvas/2d";
import { waitFor } from "@motion-canvas/core";
import type { ThreadGenerator } from "@motion-canvas/core";

import { FONT_FAMILY, FONT_URL } from "./chat-font";
import { ensureFont, measureText } from "./text-measure";

export type CornerStyle = "pill" | "rounded" | "sharp";

/** Bold, from the variable DM Sans face (wght 100-1000) already vendored for the bubbles. */
export const CTA_FONT_WEIGHT = 700;
export const CTA_LINE_HEIGHT = 1.2;
/** A touch of tracking reads better at display sizes; measured and rendered alike. */
export const CTA_LETTER_SPACING_EM = 0.01;

/** Padding and limits, as multiples of the font size / button height. */
const PAD_X_EM = 0.9;
const PAD_Y_EM = 0.45;
/** The narrowest a button may be, as a multiple of its height. */
const MIN_WIDTH_PER_HEIGHT = 2;
/** Kept clear on each side of the frame; text wraps before it would cross. */
const FRAME_MARGIN = 0.08;
const ROUNDED_RADIUS_PER_HEIGHT = 0.22;

/** Loads the button face and refuses to render in a fallback. Yield it before measuring. */
export function loadCtaFont(): Promise<void> {
  return ensureFont(FONT_FAMILY, FONT_URL, [CTA_FONT_WEIGHT]);
}

export interface CtaParams {
  text: string;
  backgroundColor: string;
  textColor: string;
  fontSize: number;
  /** 0 is the top edge of the frame, 1 the bottom; the button is centred on it. */
  positionY: number;
  durationInSeconds: number;
}

type Variables = { get: (key: string, fallback: unknown) => () => unknown };

/** Reads the params every button shares. Scene-specific ones are read by the scene. */
export function readCtaParams(variables: Variables, defaults: CtaParams): CtaParams {
  const text = String(variables.get("text", defaults.text)());
  return {
    // An empty label would measure as nothing and draw a blank pill; keep a visible fallback.
    text: text.trim() === "" ? defaults.text : text,
    backgroundColor: String(variables.get("backgroundColor", defaults.backgroundColor)()),
    textColor: String(variables.get("textColor", defaults.textColor)()),
    fontSize: clamp(Number(variables.get("fontSize", defaults.fontSize)()), 16, 200),
    positionY: clamp(Number(variables.get("positionY", defaults.positionY)()), 0.05, 0.95),
    durationInSeconds: Math.max(0.5, Number(variables.get("durationInSeconds", defaults.durationInSeconds)())),
  };
}

export interface CtaLayout {
  width: number;
  height: number;
  radius: number;
  lines: string[];
  lineHeightPx: number;
  padX: number;
  padY: number;
  fontSize: number;
  letterSpacing: number;
  /** Where the button's centre sits, in the scene's centre-origin pixels. */
  y: number;
}

/** Measures the text and works out the button's size, corner radius and position. */
export function layoutCta(
  params: Pick<CtaParams, "text" | "fontSize" | "positionY">,
  corner: CornerStyle,
  frame: { width: number; height: number },
): CtaLayout {
  const { fontSize } = params;
  const padX = PAD_X_EM * fontSize;
  const padY = PAD_Y_EM * fontSize;
  const letterSpacing = CTA_LETTER_SPACING_EM * fontSize;
  const maxButtonWidth = frame.width * (1 - 2 * FRAME_MARGIN);

  const measured = measureText(params.text, {
    fontFamily: FONT_FAMILY,
    fontSize,
    lineHeight: CTA_LINE_HEIGHT,
    fontWeight: CTA_FONT_WEIGHT,
    letterSpacing,
    maxWidth: Math.max(fontSize, maxButtonWidth - 2 * padX),
  });

  const height = measured.height + 2 * padY;
  const width = Math.max(measured.width + 2 * padX, MIN_WIDTH_PER_HEIGHT * height);
  const radius = corner === "pill" ? height / 2 : corner === "rounded" ? ROUNDED_RADIUS_PER_HEIGHT * height : 0;

  return {
    width,
    height,
    radius,
    lines: measured.lines,
    lineHeightPx: measured.lineHeightPx,
    padX,
    padY,
    fontSize,
    letterSpacing,
    y: (params.positionY - 0.5) * frame.height,
  };
}

/**
 * The label, one Txt per measured line, centred on (x, 0) of whatever it is added to.
 *
 * Lines are placed explicitly rather than left to Txt's own wrapping, so the wrap that
 * sized the button is the wrap that is drawn.
 */
export function buildCtaText(layout: CtaLayout, fill: string, x: number | (() => number) = 0): Node {
  const group = new Node({ x });
  const top = -(layout.lines.length * layout.lineHeightPx) / 2;
  layout.lines.forEach((line, i) => {
    group.add(
      (
        <Txt
          text={line}
          fontFamily={FONT_FAMILY}
          fontSize={layout.fontSize}
          fontWeight={CTA_FONT_WEIGHT}
          letterSpacing={layout.letterSpacing}
          lineHeight={layout.lineHeightPx}
          fill={fill}
          y={top + (i + 0.5) * layout.lineHeightPx}
        />
      ) as unknown as Node,
    );
  });
  return group;
}

export interface CtaShellOptions {
  /** Body fill; null for outline-only. */
  fill: string | null;
  stroke?: string | null;
  lineWidth?: number;
  textFill: string;
  /** Clip children (sheens, sweeps) to the button's own shape. */
  clip?: boolean;
}

export interface CtaShell {
  /** Positioned at the button's centre; scale / rotate / move this to animate the whole button. */
  root: Node;
  /** The button body. Decorations that belong inside the shape go in here when clip is on. */
  body: Rect;
  /** The label group, drawn above the body. */
  text: Node;
  layout: CtaLayout;
}

/**
 * Builds the button body and label and adds them to the view.
 *
 * Returns the pieces rather than a finished animation: each scene decides how it enters and
 * what it does while idle, and adds its own decorations (glows, rings, depth) to `root`.
 */
export function buildCtaShell(view: View2D, layout: CtaLayout, options: CtaShellOptions): CtaShell {
  const root = new Node({ y: layout.y });
  const body = new Rect({
    width: layout.width,
    height: layout.height,
    radius: layout.radius,
    // Spread-free nulls are fine for fill/stroke; shadowColor is the one that must not be null.
    fill: options.fill,
    stroke: options.stroke ?? null,
    lineWidth: options.lineWidth ?? 0,
    clip: options.clip ?? false,
  });
  const text = buildCtaText(layout, options.textFill);
  root.add(body);
  root.add(text);
  view.add(root);
  return { root, body, text, layout };
}

/**
 * Fills `seconds` with whole cycles of an idle animation, each about `cycleSeconds` long.
 *
 * The count is the nearest whole number and every cycle is stretched or squeezed a little
 * so they end exactly when the clip does: the button keeps moving to the last frame and
 * finishes at rest. Running whole cycles and waiting out the remainder instead left the
 * button frozen for up to a cycle at the end - measured at 1.5s of a 4s clip - which reads
 * as a bug on something meant to hold to the end. So interval params are approximate by
 * up to half a cycle.
 *
 * `minCycleSeconds` is the shortest a cycle may become (its fixed parts - a tick, a sweep -
 * must still fit); fewer, longer cycles are used rather than going below it. Each cycle
 * receives its actual length.
 */
export function* repeatFor(
  seconds: number,
  cycleSeconds: number,
  cycle: (length: number) => ThreadGenerator,
  minCycleSeconds = 0,
): ThreadGenerator {
  let cycles = Math.round(seconds / cycleSeconds);
  while (cycles > 0 && seconds / cycles < minCycleSeconds) cycles -= 1;
  if (cycles === 0) {
    yield* waitFor(Math.max(0, seconds));
    return;
  }
  const length = seconds / cycles;
  for (let i = 0; i < cycles; i += 1) {
    yield* cycle(length);
  }
}

/** Time left in the clip after the entrance, never negative. */
export function idleSeconds(params: CtaParams, restAt: number): number {
  return Math.max(0, params.durationInSeconds - restAt);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Free-text numeric params from an agent can arrive as strings; fall back when unusable. */
export function readNumber(variables: Variables, key: string, fallback: number, min: number, max: number): number {
  const value = Number(variables.get(key, fallback)());
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function readColor(variables: Variables, key: string, fallback: string): string {
  const value = String(variables.get(key, fallback)());
  return value.trim() === "" ? fallback : value;
}
