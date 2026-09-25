import { makeScene2D } from "@motion-canvas/2d";
import { easeInOutSine, easeOutElastic, useScene, waitFor } from "@motion-canvas/core";

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

const DEFAULT_PROPS = CTA_DEFAULTS["button-bounce-in"];
const ENTRANCE = 0.9;
/** Degrees for each swing of the wiggle, settling toward zero. */
const WIGGLE = [-6, 6, -4, 3, 0];
const WIGGLE_STEP = 0.1;

/**
 * Pill, solid fill. Springs in from nothing with an elastic overshoot and settle, then every
 * so often gives a quick attention wiggle - a small rotation shake that dies away.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const wiggleInterval = readNumber(variables, "wiggleInterval", DEFAULT_PROPS.wiggleInterval, 0.8, 10);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "pill", { width: frame.x, height: frame.y });
  const { root } = buildCtaShell(view, layout, {
    fill: params.backgroundColor,
    textFill: params.textColor,
  });

  root.scale(0);
  yield* root.scale(1, ENTRANCE, easeOutElastic);

  // restAt = ENTRANCE: the elastic ease ends exactly at scale 1, no rotation.
  const wiggleTime = WIGGLE.length * WIGGLE_STEP;
  yield* repeatFor(idleSeconds(params, ENTRANCE), wiggleInterval, function* (length) {
    yield* waitFor(length - wiggleTime);
    for (const angle of WIGGLE) {
      yield* root.rotation(angle, WIGGLE_STEP, easeInOutSine);
    }
  }, wiggleTime + 0.3);
  yield* holdToClipEnd(params.durationInSeconds);
});
