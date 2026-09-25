import { Rect, makeScene2D } from "@motion-canvas/2d";
import { all, createSignal, easeOutBack, easeOutQuad, useScene, waitFor } from "@motion-canvas/core";

import {
  buildCtaShell,
  holdToClipEnd,
  idleSeconds,
  layoutCta,
  loadCtaFont,
  readColor,
  readCtaParams,
  readNumber,
  repeatFor,
} from "../lib/cta-button";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";

const DEFAULT_PROPS = CTA_DEFAULTS["button-press-3d"];
const ENTRANCE = 0.45;
const PRESS_DOWN = 0.1;
const PRESS_UP = 0.25;

/**
 * Sharp corners, solid face, thick border, and a solid block of depth underneath - a chunky
 * "physical" key. Pops in, then clicks on a beat: the face drops into its depth and springs
 * back up. The depth sits straight below rather than off to one side, so the button's
 * width is exactly its face plus border.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const edge = readColor(variables, "shadowColor", DEFAULT_PROPS.shadowColor);
  const pressInterval = readNumber(variables, "pressInterval", DEFAULT_PROPS.pressInterval, 0.6, 8);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "sharp", { width: frame.x, height: frame.y });
  const border = Math.max(4, 0.045 * layout.height);
  const depth = Math.max(8, 0.1 * layout.height);
  const { root, body, text } = buildCtaShell(view, layout, {
    fill: params.backgroundColor,
    stroke: edge,
    lineWidth: border,
    textFill: params.textColor,
  });

  const block = new Rect({
    width: layout.width,
    height: layout.height,
    y: depth,
    fill: edge,
    stroke: edge,
    lineWidth: border,
  });
  root.insert(block, 0);

  // 0 = up, 1 = pressed fully into the depth.
  const press = createSignal(0);
  body.y(() => press() * depth);
  text.y(() => press() * depth);

  root.scale(0.7);
  root.opacity(0);
  yield* all(root.scale(1, ENTRANCE, easeOutBack), root.opacity(1, ENTRANCE * 0.6));

  // restAt = ENTRANCE: face up, full size.
  yield* repeatFor(idleSeconds(params, ENTRANCE), pressInterval, function* (length) {
    yield* waitFor(length - PRESS_DOWN - PRESS_UP);
    yield* press(1, PRESS_DOWN, easeOutQuad);
    yield* press(0, PRESS_UP, easeOutBack);
  }, PRESS_DOWN + PRESS_UP + 0.2);
  yield* holdToClipEnd(params.durationInSeconds);
});
