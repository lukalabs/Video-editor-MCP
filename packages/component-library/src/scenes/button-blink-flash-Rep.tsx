import { makeScene2D } from "@motion-canvas/2d";
import { all, easeOutCubic, easeOutQuad, useScene, waitFor } from "@motion-canvas/core";

import {
  buildCtaShell,
  idleSeconds,
  layoutCta,
  loadCtaFont,
  readColor,
  readCtaParams,
  readNumber,
  repeatFor,
} from "../lib/cta-button";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";

const DEFAULT_PROPS = CTA_DEFAULTS["button-blink-flash-Rep"];
const ENTRANCE = 0.3;
const TICK_UP = 0.06;
const TICK_DOWN = 0.12;

/**
 * Sharp corners, solid fill, urgent: the fill snaps between `backgroundColor` and
 * `flashColor` on a steady beat, with a quick scale tick on each flash - the "LIVE" /
 * "LIMITED TIME" look. The switch is a hard cut, not a fade, which is what reads as a blink.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const flashColor = readColor(variables, "flashColor", DEFAULT_PROPS.flashColor);
  const blinkInterval = readNumber(variables, "blinkInterval", DEFAULT_PROPS.blinkInterval, 0.2, 4);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "sharp", { width: frame.x, height: frame.y });
  const { root, body } = buildCtaShell(view, layout, {
    fill: params.backgroundColor,
    textFill: params.textColor,
  });

  root.scale(0.9);
  root.opacity(0);
  yield* all(root.scale(1, ENTRANCE, easeOutCubic), root.opacity(1, ENTRANCE, easeOutCubic));

  // restAt = ENTRANCE: main colour, full size.
  yield* repeatFor(idleSeconds(params, ENTRANCE), blinkInterval * 2, function* (length) {
    const half = length / 2;
    const tick = Math.min(TICK_UP + TICK_DOWN, half);
    body.fill(flashColor);
    yield* root.scale(1.04, (TICK_UP / (TICK_UP + TICK_DOWN)) * tick, easeOutQuad);
    yield* root.scale(1, (TICK_DOWN / (TICK_UP + TICK_DOWN)) * tick, easeOutQuad);
    yield* waitFor(half - tick);
    body.fill(params.backgroundColor);
    yield* waitFor(half);
  });
});
