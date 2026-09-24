import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/button-ghost-float-Rep?scene";
import { CTA_DEFAULTS } from "../lib/cta-button-defaults";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = { ...CTA_DEFAULTS["button-ghost-float-Rep"] };

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
