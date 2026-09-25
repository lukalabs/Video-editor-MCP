import { Rect, makeScene2D } from "@motion-canvas/2d";
import { createSignal, easeInOutCubic, easeOutCubic, useScene, waitFor } from "@motion-canvas/core";

import {
  buildCtaShell,
  buildCtaText,
  idleSeconds,
  layoutCta,
  loadCtaFont,
  readCtaParams,
  readNumber,
  repeatFor,
} from "../lib/cta-button";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";

const DEFAULT_PROPS = CTA_DEFAULTS["button-fill-sweep"];
const FADE_IN = 0.4;
const BEAT = 0.3;
const HOLD_FILLED = 0.9;
const HOLD_OUTLINE = 0.2;

/**
 * Slightly rounded. Starts as an outline with the label in the outline colour; then a solid
 * fill wipes in left to right, and the label flips to `textColor` exactly where the fill
 * has reached it - mid-sweep the word is two colours. While idle it wipes back out and in
 * again. `backgroundColor` is both the border and the fill.
 *
 * How the flip works: the fill is its own clipping rectangle that grows from the left edge,
 * holding a second copy of the label in `textColor`. That copy is pinned to the button's
 * centre (its x cancels the rectangle's), so as the rectangle widens it uncovers more of
 * the inverted word over the plain one.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const borderWidth = readNumber(variables, "borderWidth", DEFAULT_PROPS.borderWidth, 1, 24);
  const sweepSeconds = readNumber(variables, "sweepSeconds", DEFAULT_PROPS.sweepSeconds, 0.2, 4);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "rounded", { width: frame.x, height: frame.y });
  const { root, body, text } = buildCtaShell(view, layout, {
    fill: null,
    stroke: params.backgroundColor,
    lineWidth: borderWidth,
    textFill: params.backgroundColor,
    clip: true,
  });
  // The plain label has to sit under the sweep, so it moves inside the clipped body.
  text.reparent(body);

  // Fill progress 0..1. `fromRight` switches the anchored edge, so the wipe-out continues
  // left to right instead of reversing.
  const progress = createSignal(0);
  const fromRight = createSignal(false);
  const w = layout.width;
  const sweep = new Rect({
    height: layout.height,
    width: () => w * progress(),
    x: () => (fromRight() ? w / 2 - (w * progress()) / 2 : -w / 2 + (w * progress()) / 2),
    fill: params.backgroundColor,
    clip: true,
  });
  sweep.add(buildCtaText(layout, params.textColor, () => -sweep.x()));
  body.add(sweep);

  root.opacity(0);
  yield* root.opacity(1, FADE_IN, easeOutCubic);
  yield* waitFor(BEAT);
  yield* progress(1, sweepSeconds, easeInOutCubic);

  // restAt = FADE_IN + BEAT + sweepSeconds: fully filled, label in textColor.
  const cycle = HOLD_FILLED + sweepSeconds + HOLD_OUTLINE + sweepSeconds;
  // The two sweeps and the outline beat are fixed; the filled hold absorbs the fitting.
  const fixed = 2 * sweepSeconds + HOLD_OUTLINE;
  yield* repeatFor(idleSeconds(params, FADE_IN + BEAT + sweepSeconds), cycle, function* (length) {
    yield* waitFor(length - fixed);
    fromRight(true);
    yield* progress(0, sweepSeconds, easeInOutCubic);
    fromRight(false);
    yield* waitFor(HOLD_OUTLINE);
    yield* progress(1, sweepSeconds, easeInOutCubic);
  }, fixed + 0.3);
});
