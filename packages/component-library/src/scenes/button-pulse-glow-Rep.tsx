import { makeScene2D } from "@motion-canvas/2d";
import { all, createSignal, easeInOutSine, easeOutBack, useScene } from "@motion-canvas/core";

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

const DEFAULT_PROPS = CTA_DEFAULTS["button-pulse-glow-Rep"];

const ENTRANCE = 0.5;

/**
 * Pill, solid fill. Pops in, then breathes: the button swells slightly while a soft glow in
 * `glowColor` blooms around it and fades, on a steady beat. The glow is off at rest, so the
 * resting frame shows the button alone.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const glowColor = readColor(variables, "glowColor", DEFAULT_PROPS.glowColor);
  const pulseSeconds = readNumber(variables, "pulseSeconds", DEFAULT_PROPS.pulseSeconds, 0.4, 6);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "pill", { width: frame.x, height: frame.y });
  const glow = createSignal(0);
  const { root, body } = buildCtaShell(view, layout, {
    fill: params.backgroundColor,
    textFill: params.textColor,
  });
  body.shadowColor(glowColor);
  body.shadowBlur(() => glow() * layout.fontSize);

  root.scale(0.5);
  root.opacity(0);
  yield* all(root.scale(1, ENTRANCE, easeOutBack), root.opacity(1, ENTRANCE * 0.6));

  // restAt = ENTRANCE: scale 1, glow 0.
  yield* repeatFor(idleSeconds(params, ENTRANCE), pulseSeconds, function* (length) {
    const half = length / 2;
    yield* all(root.scale(1.05, half, easeInOutSine), glow(1, half, easeInOutSine));
    yield* all(root.scale(1, half, easeInOutSine), glow(0, half, easeInOutSine));
  });
});
