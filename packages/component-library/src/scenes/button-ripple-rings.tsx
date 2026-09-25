import { Rect, makeScene2D } from "@motion-canvas/2d";
import { all, createSignal, delay, easeOutBack, easeOutCubic, useScene, waitFor } from "@motion-canvas/core";

import {
  FIT_SLACK,
  buildCtaShell,
  holdToClipEnd,
  idleSeconds,
  layoutCta,
  loadCtaFont,
  readColor,
  readCtaParams,
  readNumber,
} from "../lib/cta-button";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";

const DEFAULT_PROPS = CTA_DEFAULTS["button-ripple-rings"];
const ENTRANCE = 0.45;
const RING_LIFE = 1.2;
const RING_START_OPACITY = 0.7;

/**
 * Slightly rounded, solid fill - a "tap here" button. After it lands, rings in the button's
 * own shape expand out from its edge and fade, one after another, like sonar.
 *
 * Rings are drawn behind the button and reused from a small pool: a ring is only picked up
 * again once its previous ripple has finished, so a long clip does not pile up nodes.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const params = readCtaParams(variables, DEFAULT_PROPS);
  const rippleColor = readColor(variables, "rippleColor", DEFAULT_PROPS.rippleColor);
  const rippleInterval = readNumber(variables, "rippleInterval", DEFAULT_PROPS.rippleInterval, 0.3, 4);

  yield loadCtaFont();

  const frame = view.size();
  const layout = layoutCta(params, "rounded", { width: frame.x, height: frame.y });
  const { root } = buildCtaShell(view, layout, {
    fill: params.backgroundColor,
    textFill: params.textColor,
  });

  const reach = 0.9 * layout.height;
  function makeRing() {
    // How far this ring has grown past the button's edge, 0..reach.
    const grow = createSignal(0);
    const ring = new Rect({
      width: () => layout.width + 2 * grow(),
      height: () => layout.height + 2 * grow(),
      radius: () => layout.radius + grow(),
      stroke: rippleColor,
      lineWidth: Math.max(3, 0.05 * layout.height),
      opacity: 0,
    });
    root.insert(ring, 0);
    return { ring, grow };
  }
  const rings = Array.from({ length: Math.ceil(RING_LIFE / rippleInterval) + 1 }, makeRing);

  function* ripple(index: number) {
    const { ring, grow } = rings[index % rings.length];
    grow(0);
    ring.opacity(RING_START_OPACITY);
    yield* all(grow(reach, RING_LIFE, easeOutCubic), ring.opacity(0, RING_LIFE, easeOutCubic));
  }

  root.scale(0.6);
  root.opacity(0);
  yield* all(root.scale(1, ENTRANCE, easeOutBack), root.opacity(1, ENTRANCE * 0.6));

  // restAt = ENTRANCE: full size; the first ring starts here, at the edge.
  // Short of the clip end by FIT_SLACK, for the same reason repeatFor is.
  const idle = Math.max(0, idleSeconds(params, ENTRANCE) - FIT_SLACK);
  // Spacing is fitted like repeatFor's cycles: the nearest whole number of rings, spread so
  // the last one finishes exactly as the clip ends - no ring cut off mid-ripple, and no dead
  // stretch at the end. rippleInterval is therefore approximate.
  const count = idle >= RING_LIFE ? Math.round((idle - RING_LIFE) / rippleInterval) + 1 : 0;
  const spacing = count > 1 ? (idle - RING_LIFE) / (count - 1) : 0;
  // The pool must cover every ring still expanding when the next one starts.
  if (count > 1 && Math.ceil(RING_LIFE / spacing) + 1 > rings.length) {
    for (let i = rings.length; i < Math.ceil(RING_LIFE / spacing) + 1; i += 1) rings.push(makeRing());
  }
  yield* all(...Array.from({ length: count }, (_, i) => delay(i * spacing, ripple(i))));
  const ringsEnd = count > 0 ? (count - 1) * spacing + RING_LIFE : 0;
  yield* waitFor(Math.max(0, idle - ringsEnd));
  yield* holdToClipEnd(params.durationInSeconds);
});
