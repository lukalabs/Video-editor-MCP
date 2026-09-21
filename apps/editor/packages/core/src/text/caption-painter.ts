import type { Subtitle } from "../types/timeline";
import {
  renderAnimatedCaption,
  type WordSegment,
} from "./caption-animation-renderer";

/**
 * The 2D canvas API surface caption painting needs. Both the preview
 * (CanvasRenderingContext2D) and the export worker
 * (OffscreenCanvasRenderingContext2D) satisfy it.
 */
export type CaptionCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

const DEFAULT_FONT_SIZE = 24;
const DEFAULT_FONT_FAMILY = "Inter";
const DEFAULT_COLOR = "#ffffff";
const DEFAULT_BACKGROUND = "rgba(0, 0, 0, 0.7)";
const DEFAULT_HIGHLIGHT = "#ffff00";

interface ResolvedStyle {
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly fontWeight: string;
  readonly color: string;
  readonly backgroundColor: string;
  readonly position: "top" | "center" | "bottom";
  readonly highlightColor?: string;
  readonly outlineColor?: string;
  readonly outlineWidth: number;
  readonly highlightBackgroundColor?: string;
  readonly highlightRadius: number;
  readonly shadowColor?: string;
  readonly shadowBlur: number;
  readonly shadowOffsetY: number;
  readonly verticalAnchor?: number;
}

function resolveStyle(subtitle: Subtitle): ResolvedStyle {
  const style = subtitle.style;
  return {
    fontSize: style?.fontSize || DEFAULT_FONT_SIZE,
    fontFamily: style?.fontFamily || DEFAULT_FONT_FAMILY,
    fontWeight: style?.fontWeight || "bold",
    color: style?.color || DEFAULT_COLOR,
    backgroundColor: style?.backgroundColor || DEFAULT_BACKGROUND,
    position: style?.position || "bottom",
    highlightColor: style?.highlightColor,
    outlineColor: style?.outlineColor,
    outlineWidth: style?.outlineWidth ?? 0,
    highlightBackgroundColor: style?.highlightBackgroundColor,
    highlightRadius: style?.highlightRadius ?? 0,
    shadowColor: style?.shadowColor,
    shadowBlur: style?.shadowBlur ?? 0,
    shadowOffsetY: style?.shadowOffsetY ?? 0,
    verticalAnchor: style?.verticalAnchor,
  };
}

export function getSegmentColor(
  segment: WordSegment,
  baseColor: string,
  highlightColor?: string,
): string {
  if (segment.color) {
    if (segment.color.startsWith("linear-gradient")) {
      return highlightColor || DEFAULT_HIGHLIGHT;
    }
    if (segment.color === "transparent") {
      return "rgba(0,0,0,0)";
    }
    return segment.color;
  }

  switch (segment.style) {
    case "highlighted":
    case "active":
      return highlightColor || DEFAULT_HIGHLIGHT;
    case "hidden":
      return "rgba(0,0,0,0)";
    default:
      return baseColor;
  }
}

/**
 * Baseline for the first caption line. `verticalAnchor` wins when set; the
 * three-value `position` is the fallback.
 */
function resolveBaseY(
  resolved: ResolvedStyle,
  canvasHeight: number,
  blockHeight: number,
): number {
  if (resolved.verticalAnchor !== undefined) {
    return canvasHeight * resolved.verticalAnchor - blockHeight / 2;
  }
  if (resolved.position === "top") {
    return resolved.fontSize * 2;
  }
  if (resolved.position === "center") {
    return canvasHeight / 2 - blockHeight / 2;
  }
  return canvasHeight - resolved.fontSize * 2 - blockHeight;
}

/**
 * Draw one run of text with its outline and shadow. The shadow is attached to
 * the outline pass when there is one, so it is cast once by the whole glyph
 * rather than twice.
 */
function paintText(
  ctx: CaptionCanvasContext,
  resolved: ResolvedStyle,
  text: string,
  x: number,
  y: number,
  fillColor: string,
): void {
  const hasShadow =
    !!resolved.shadowColor &&
    (resolved.shadowBlur > 0 || resolved.shadowOffsetY !== 0);
  const hasOutline = !!resolved.outlineColor && resolved.outlineWidth > 0;

  if (hasShadow) {
    ctx.shadowColor = resolved.shadowColor as string;
    ctx.shadowBlur = resolved.shadowBlur;
    ctx.shadowOffsetY = resolved.shadowOffsetY;
  }

  if (hasOutline) {
    ctx.lineWidth = resolved.outlineWidth;
    ctx.strokeStyle = resolved.outlineColor as string;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(text, x, y);
  }

  // The fill must not cast a second shadow on top of the outline's.
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);
}

/**
 * Width of a single space in the current font. `measureText(" ")` and trailing
 * spaces are trimmed by canvas, so the space is measured by difference.
 */
function measureSpace(ctx: CaptionCanvasContext): number {
  return ctx.measureText("i i").width - ctx.measureText("ii").width;
}

/** Solid block behind the word that is being spoken. */
function paintHighlightBlock(
  ctx: CaptionCanvasContext,
  resolved: ResolvedStyle,
  x: number,
  y: number,
  wordWidth: number,
  lineHeight: number,
): void {
  const padX = resolved.fontSize * 0.16;
  const padY = resolved.fontSize * 0.12;
  const left = x - padX;
  const top = y - lineHeight / 2 - padY + resolved.fontSize * 0.06;
  const width = wordWidth + padX * 2;
  const height = lineHeight + padY * 2;

  ctx.fillStyle = resolved.highlightBackgroundColor as string;
  ctx.beginPath();
  if (resolved.highlightRadius > 0 && typeof ctx.roundRect === "function") {
    ctx.roundRect(left, top, width, height, resolved.highlightRadius);
  } else {
    ctx.rect(left, top, width, height);
  }
  ctx.fill();
}

function paintStaticSubtitle(
  ctx: CaptionCanvasContext,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const resolved = resolveStyle(subtitle);
  const { fontSize, fontFamily, fontWeight, color, backgroundColor } = resolved;

  ctx.save();
  ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = subtitle.text.split("\n");
  const lineHeight = fontSize * 1.3;
  const totalHeight = lines.length * lineHeight;
  const baseY = resolveBaseY(resolved, canvasHeight, totalHeight);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const y = baseY + i * lineHeight + lineHeight / 2;
    const bgWidth = ctx.measureText(line).width + 20;

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(
      canvasWidth / 2 - bgWidth / 2,
      y - lineHeight / 2,
      bgWidth,
      lineHeight,
    );

    paintText(ctx, resolved, line, canvasWidth / 2, y, color);
  }

  ctx.restore();
}

function paintAnimatedSubtitle(
  ctx: CaptionCanvasContext,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
  currentTime: number,
): void {
  const frame = renderAnimatedCaption(subtitle, currentTime);
  if (!frame.visible || frame.segments.length === 0) return;

  const resolved = resolveStyle(subtitle);
  const { fontSize, fontFamily, fontWeight, color, backgroundColor, highlightColor } =
    resolved;

  ctx.save();
  ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}"`;
  ctx.textBaseline = "middle";

  const lineHeight = fontSize * 1.3;
  const baseY = resolveBaseY(resolved, canvasHeight, lineHeight) + lineHeight / 2;

  // The highlight block is padded, so words need a wider gap or the block
  // crowds its neighbour. Constant, so the layout does not shift as it moves.
  const spaceWidth =
    measureSpace(ctx) +
    (resolved.highlightBackgroundColor ? resolved.fontSize * 0.22 : 0);
  // A scaled-up word needs a wider slot or it overlaps its neighbours. A word
  // scaling up from small (bounce, pop-in) keeps its settled slot instead, so
  // the line does not jitter while it animates.
  const slotWidths = frame.segments.map(
    (segment) =>
      ctx.measureText(segment.text).width * Math.max(1, segment.scale || 1),
  );
  const totalWidth =
    slotWidths.reduce((sum, width) => sum + width, 0) +
    spaceWidth * Math.max(0, frame.segments.length - 1);

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(
    canvasWidth / 2 - (totalWidth + 30) / 2,
    baseY - (lineHeight + 10) / 2,
    totalWidth + 30,
    lineHeight + 10,
  );

  let xOffset = canvasWidth / 2 - totalWidth / 2;

  frame.segments.forEach((segment, index) => {
    ctx.save();
    ctx.globalAlpha = segment.opacity;

    // Centre the word in its slot and scale about that centre, so the word
    // grows symmetrically and still fills exactly the slot it was given.
    const centerX = xOffset + slotWidths[index] / 2;
    const centerY = baseY + segment.offsetY;

    ctx.translate(centerX, centerY);
    ctx.scale(segment.scale, segment.scale);
    ctx.translate(-centerX, -centerY);

    const isActiveWord =
      segment.style === "active" || segment.style === "highlighted";
    if (resolved.highlightBackgroundColor && isActiveWord) {
      paintHighlightBlock(
        ctx,
        resolved,
        centerX - slotWidths[index] / 2,
        centerY,
        slotWidths[index],
        lineHeight,
      );
    }

    ctx.textAlign = "center";
    paintText(
      ctx,
      resolved,
      segment.text,
      centerX,
      centerY,
      getSegmentColor(segment, color, highlightColor),
    );

    ctx.restore();

    xOffset += slotWidths[index] + spaceWidth;
  });

  ctx.restore();
}

/**
 * Paint one subtitle onto a 2D canvas. Animated caption styles need
 * `currentTime`; without it the subtitle's own start time is used, which
 * renders the first frame of the animation.
 */
export function paintSubtitle(
  ctx: CaptionCanvasContext,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
  currentTime?: number,
): void {
  const { text, animationStyle, words } = subtitle;
  if (!text || text.trim().length === 0) return;

  const hasAnimation =
    animationStyle && animationStyle !== "none" && words && words.length > 0;

  if (hasAnimation) {
    paintAnimatedSubtitle(
      ctx,
      subtitle,
      canvasWidth,
      canvasHeight,
      currentTime ?? subtitle.startTime,
    );
  } else {
    paintStaticSubtitle(ctx, subtitle, canvasWidth, canvasHeight);
  }
}
