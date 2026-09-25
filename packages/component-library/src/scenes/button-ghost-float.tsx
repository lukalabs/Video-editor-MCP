import { makeScene2D } from "@motion-canvas/2d";
import { Color, all, createSignal, easeInOutSine, easeOutCubic, useScene } from "@motion-canvas/core";

import {
  buildCtaShell,
  holdToClipEnd,
  idleSeconds,
  layoutCta,
  loadCtaFont,
  readCtaParams,
  readNumber,
  repeatFor,
} from "../lib/cta-button";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";

const DEFAULT_PROPS = CTA_DEFAULTS["button-ghost-float"];
const ENTRANCE = 0.6;
const FLOAT_CYCLE = 2.4;

/**
 * Pill, ghost style: a hairline border around a glassy, mostly transparent fill, made for
 * sitting over busy footage. Rises in as it fades up, then drifts gently up and down while
 * the fill breathes a little brighter and back. `backgroundColor` tints both the border
 * and the fill.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const fillOpacity = readNumber(variables, "fillOpacity", DEFAULT_PROPS.fillOpacity, 0, 0.9);
  const floatAmount = readNumber(variables, "floatAmount", DEFAULT_PROPS.floatAmount, 0, 60);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "pill", { width: frame.x, height: frame.y });
  const tint = new Color(params.backgroundColor);
  const breath = createSignal(0);
  const { root, body } = buildCtaShell(view, layout, {
    fill: null,
    stroke: params.backgroundColor,
    lineWidth: Math.max(2, 0.03 * layout.height),
    textFill: params.textColor,
  });
  body.fill(() => tint.alpha(Math.min(0.95, fillOpacity * (1 + 0.6 * breath()))));

  const restY = root.y();
  root.y(restY + 0.3 * layout.height);
  root.opacity(0);
  yield* all(root.y(restY, ENTRANCE, easeOutCubic), root.opacity(1, ENTRANCE, easeOutCubic));

  // restAt = ENTRANCE: at its resting height, fill at fillOpacity.
  yield* repeatFor(idleSeconds(params, ENTRANCE), FLOAT_CYCLE, function* (length) {
    const half = length / 2;
    yield* all(root.y(restY - floatAmount, half, easeInOutSine), breath(1, half, easeInOutSine));
    yield* all(root.y(restY, half, easeInOutSine), breath(0, half, easeInOutSine));
  });
  yield* holdToClipEnd(params.durationInSeconds);
});
