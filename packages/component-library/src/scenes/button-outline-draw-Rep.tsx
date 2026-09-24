import { makeScene2D } from "@motion-canvas/2d";
import { all, easeInOutCubic, easeInOutSine, easeOutCubic, useScene } from "@motion-canvas/core";

import {
  buildCtaShell,
  idleSeconds,
  layoutCta,
  loadCtaFont,
  readCtaParams,
  readNumber,
  repeatFor,
} from "../lib/cta-button";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";

const DEFAULT_PROPS = CTA_DEFAULTS["button-outline-draw-Rep"];
const LABEL_IN = 0.3;
const BREATH = 1.8;

/**
 * Sharp corners, outline only - no fill, so footage shows through. The border draws itself
 * around the whole rectangle, the label rises into place, and then the border breathes
 * softly while it holds. `backgroundColor` is the outline colour for this style.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const borderWidth = readNumber(variables, "borderWidth", DEFAULT_PROPS.borderWidth, 1, 24);
  const drawSeconds = readNumber(variables, "drawSeconds", DEFAULT_PROPS.drawSeconds, 0.3, 4);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "sharp", { width: frame.x, height: frame.y });
  const { body, text } = buildCtaShell(view, layout, {
    fill: null,
    stroke: params.backgroundColor,
    lineWidth: borderWidth,
    textFill: params.textColor,
  });

  body.end(0);
  text.opacity(0);
  text.y(0.2 * layout.fontSize);
  yield* body.end(1, drawSeconds, easeInOutCubic);
  yield* all(text.opacity(1, LABEL_IN, easeOutCubic), text.y(0, LABEL_IN, easeOutCubic));

  // restAt = drawSeconds + LABEL_IN: border complete, label in place.
  yield* repeatFor(idleSeconds(params, drawSeconds + LABEL_IN), BREATH, function* (length) {
    yield* body.opacity(0.45, length / 2, easeInOutSine);
    yield* body.opacity(1, length / 2, easeInOutSine);
  });
});
