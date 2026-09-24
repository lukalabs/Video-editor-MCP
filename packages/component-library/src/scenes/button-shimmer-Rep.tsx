import { Gradient, Rect, makeScene2D } from "@motion-canvas/2d";
import { Color, all, easeInOutSine, easeOutCubic, linear, useScene, waitFor } from "@motion-canvas/core";

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

const DEFAULT_PROPS = CTA_DEFAULTS["button-shimmer-Rep"];
const ENTRANCE = 0.5;
const SHEEN_TILT_DEG = 20;

/**
 * Slightly rounded, solid fill. Slides up into place, then a diagonal band of light sweeps
 * across it on a loop. The band lives inside the button with clipping on, so it follows
 * the rounded corners instead of spilling past them, and passes under the label.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const shimmerColor = readColor(variables, "shimmerColor", DEFAULT_PROPS.shimmerColor);
  const interval = readNumber(variables, "shimmerInterval", DEFAULT_PROPS.shimmerInterval, 0.8, 8);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "rounded", { width: frame.x, height: frame.y });
  const { root, body } = buildCtaShell(view, layout, {
    fill: params.backgroundColor,
    textFill: params.textColor,
    clip: true,
  });

  const bandWidth = 0.4 * layout.height;
  const clear = new Color(shimmerColor).alpha(0);
  const bright = new Color(shimmerColor).alpha(0.55);
  // Far enough out that the tilted band is fully off the button at both ends of a sweep.
  const travel = layout.width / 2 + layout.height;
  const sheen = new Rect({
    width: bandWidth,
    height: layout.height * 3,
    rotation: SHEEN_TILT_DEG,
    x: -travel,
    fill: new Gradient({
      type: "linear",
      fromX: -bandWidth / 2,
      toX: bandWidth / 2,
      stops: [
        { offset: 0, color: clear },
        { offset: 0.5, color: bright },
        { offset: 1, color: clear },
      ],
    }),
  });
  body.add(sheen);

  const restY = root.y();
  root.y(restY + 0.4 * layout.height);
  root.opacity(0);
  yield* all(root.y(restY, ENTRANCE, easeOutCubic), root.opacity(1, ENTRANCE * 0.7, easeInOutSine));

  // restAt = ENTRANCE: in place, band parked off the left edge.
  yield* repeatFor(idleSeconds(params, ENTRANCE), interval, function* (length) {
    const sweep = Math.min(0.9, length * 0.55);
    yield* sheen.x(travel, sweep, linear);
    sheen.x(-travel);
    yield* waitFor(length - sweep);
  });
});
