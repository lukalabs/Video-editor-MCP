import { Gradient, makeScene2D } from "@motion-canvas/2d";
import { all, createSignal, easeOutCubic, linear, useScene } from "@motion-canvas/core";

import {
  buildCtaShell,
  holdToClipEnd,
  layoutCta,
  loadCtaFont,
  readColor,
  readCtaParams,
  readNumber,
  repeatFor,
} from "../lib/cta-button";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";

const DEFAULT_PROPS = CTA_DEFAULTS["button-gradient-flow"];
const ENTRANCE = 0.5;

/**
 * Pill with a two-colour gradient that scrolls continuously through the fill, so the colour
 * flows under the label. Fades in while it is already flowing.
 *
 * Seamless looping: the gradient spans three button-widths with the two colours repeating
 * every width (A B A B A B A). It scrolls by exactly one width per cycle, so the end of a
 * cycle is indistinguishable from its start, and the button never sees past either end of
 * the gradient, where the canvas would pad with a flat colour.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const second = readColor(variables, "gradientColor", DEFAULT_PROPS.gradientColor);
  const flowSeconds = readNumber(variables, "flowSeconds", DEFAULT_PROPS.flowSeconds, 0.5, 12);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "pill", { width: frame.x, height: frame.y });
  const period = layout.width;
  const shift = createSignal(0);
  const first = params.backgroundColor;
  const { root, body } = buildCtaShell(view, layout, {
    fill: params.backgroundColor,
    textFill: params.textColor,
  });
  body.fill(
    new Gradient({
      type: "linear",
      fromX: () => -layout.width / 2 - period + shift(),
      toX: () => -layout.width / 2 + 2 * period + shift(),
      stops: [first, second, first, second, first, second, first].map((color, i) => ({
        offset: i / 6,
        color,
      })),
    }),
  );

  function* flow(seconds: number) {
    yield* repeatFor(seconds, flowSeconds, function* (length) {
      yield* shift(period, length, linear);
      shift(0);
    });
  }

  root.scale(0.9);
  root.opacity(0);
  // The flow runs for the whole clip, entrance included; restAt = ENTRANCE (full size).
  yield* all(
    flow(params.durationInSeconds),
    root.scale(1, ENTRANCE, easeOutCubic),
    root.opacity(1, ENTRANCE, easeOutCubic),
  );
  yield* holdToClipEnd(params.durationInSeconds);
});
