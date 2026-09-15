import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/button?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  label: "Get started",
  fillColor: "#34d399",
  textColor: "#0b1220",
  width: 420,
  height: 120,
  cornerRadius: 60,
  fontSize: 42,
  outlined: false,
  borderWidth: 4,
  shadow: true,
  positionY: 0.5,
  holdToEnd: false,
  slideSeconds: 0.8,
  animation: "popIn",
  easing: "soft",
  durationInSeconds: 3,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
