/**
 * Default props for the ten CTA buttons, in one place.
 *
 * Both each button's project (for resolveProps) and its scene (for the variables.get
 * fallbacks) need these. A project imports its scene through Motion Canvas's `?scene`
 * import, which exposes no named exports, so the scene cannot import defaults from its
 * own project file without a cycle - and a defaults file per button would be ten more
 * files for ten small objects. They must also match each meta.json's param defaults.
 *
 * Every button shares text / backgroundColor / textColor / fontSize / positionY /
 * durationInSeconds. For outline and ghost styles `backgroundColor` is the outline (and
 * tint) colour: keeping one key across the set means an agent can pass the same props to
 * any of them.
 */
const SHARED = {
  text: "Get Started",
  fontSize: 64,
  positionY: 0.5,
  durationInSeconds: 4,
};

export const CTA_DEFAULTS = {
  "button-pulse-glow-Rep": {
    ...SHARED,
    backgroundColor: "#2563eb",
    textColor: "#ffffff",
    glowColor: "#60a5fa",
    pulseSeconds: 1.2,
  },
  "button-shimmer-Rep": {
    ...SHARED,
    backgroundColor: "#7c3aed",
    textColor: "#ffffff",
    shimmerColor: "#ffffff",
    shimmerInterval: 1.8,
  },
  "button-outline-draw-Rep": {
    ...SHARED,
    backgroundColor: "#f8fafc",
    textColor: "#f8fafc",
    borderWidth: 6,
    drawSeconds: 0.9,
  },
  "button-fill-sweep-Rep": {
    ...SHARED,
    backgroundColor: "#f97316",
    textColor: "#ffffff",
    borderWidth: 5,
    // With the default 4s clip this leaves room for one full wipe-out-and-back while idle.
    sweepSeconds: 0.6,
  },
  "button-ghost-float-Rep": {
    ...SHARED,
    backgroundColor: "#ffffff",
    textColor: "#ffffff",
    fillOpacity: 0.18,
    floatAmount: 12,
  },
  "button-press-3d-Rep": {
    ...SHARED,
    backgroundColor: "#facc15",
    textColor: "#111827",
    shadowColor: "#111827",
    pressInterval: 1.6,
  },
  "button-bounce-in-Rep": {
    ...SHARED,
    backgroundColor: "#ec4899",
    textColor: "#ffffff",
    wiggleInterval: 2.2,
  },
  "button-blink-flash-Rep": {
    ...SHARED,
    backgroundColor: "#dc2626",
    textColor: "#ffffff",
    // Deep enough that the white label stays readable mid-flash (~3.6:1); amber was ~1.7:1.
    flashColor: "#ea580c",
    blinkInterval: 0.5,
  },
  "button-gradient-flow-Rep": {
    ...SHARED,
    backgroundColor: "#06b6d4",
    textColor: "#ffffff",
    gradientColor: "#8b5cf6",
    flowSeconds: 2.5,
  },
  "button-ripple-rings-Rep": {
    ...SHARED,
    backgroundColor: "#10b981",
    textColor: "#ffffff",
    rippleColor: "#10b981",
    rippleInterval: 0.9,
  },
} as const;

export type CtaButtonId = keyof typeof CTA_DEFAULTS;
