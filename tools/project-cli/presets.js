/**
 * Caption presets in the editor's own SubtitleStyle terms.
 *
 * `fontFamily` is a CSS family the editor can resolve, not a font file — the burn-in
 * pipeline in tools/short-form-captions loads files, the editor resolves families.
 */
export const CAPTION_PRESETS = {
  hormozi: {
    label: "Hormozi",
    uppercase: true,
    animationStyle: "word-highlight",
    style: {
      fontFamily: "Montserrat",
      fontWeight: "900",
      fontSize: 84,
      color: "#ffffff",
      highlightColor: "#ffe81f",
      backgroundColor: "rgba(0,0,0,0)",
      position: "bottom",
      verticalAnchor: 0.74,
      outlineColor: "#000000",
      outlineWidth: 14,
      shadowColor: "rgba(0,0,0,0.55)",
      shadowBlur: 9,
      shadowOffsetY: 5,
    },
  },
  clean: {
    label: "Clean minimal",
    animationStyle: "none",
    style: {
      fontFamily: "Poppins",
      fontWeight: "900",
      fontSize: 64,
      color: "#ffffff",
      backgroundColor: "rgba(0,0,0,0)",
      position: "bottom",
      verticalAnchor: 0.74,
      outlineColor: "#000000",
      outlineWidth: 5,
      shadowColor: "rgba(0,0,0,0.55)",
      shadowBlur: 7,
      shadowOffsetY: 4,
    },
  },
  bounce: {
    label: "TikTok Bounce",
    animationStyle: "bounce",
    style: {
      fontFamily: "Inter",
      fontWeight: "900",
      fontSize: 74,
      color: "#ffffff",
      // Without this the renderer tints the spoken word its default yellow.
      highlightColor: "#ffffff",
      backgroundColor: "rgba(0,0,0,0)",
      position: "bottom",
      verticalAnchor: 0.74,
      outlineColor: "#000000",
      outlineWidth: 11,
      shadowColor: "rgba(0,0,0,0.55)",
      shadowBlur: 8,
      shadowOffsetY: 4,
    },
  },
  boxed: {
    label: "Boxed",
    animationStyle: "word-by-word",
    style: {
      fontFamily: "Rubik",
      fontWeight: "900",
      fontSize: 60,
      color: "#ffffff",
      highlightColor: "#ffffff",
      backgroundColor: "rgba(0,0,0,0.82)",
      position: "bottom",
      verticalAnchor: 0.74,
    },
  },
  "highlight-box": {
    label: "Highlight box",
    animationStyle: "word-highlight",
    style: {
      fontFamily: "Poppins",
      fontWeight: "900",
      fontSize: 70,
      color: "#ffffff",
      highlightColor: "#ffffff",
      highlightBackgroundColor: "#ff2d6f",
      highlightRadius: 14,
      backgroundColor: "rgba(0,0,0,0)",
      position: "bottom",
      verticalAnchor: 0.74,
      outlineColor: "#000000",
      outlineWidth: 8,
    },
  },
};

/** Scales a preset's pixel sizes from its 1080-wide reference to the real frame. */
export function scalePreset(preset, frameWidth) {
  const scale = frameWidth / 1080;
  if (scale === 1) return preset.style;

  const scaled = { ...preset.style };
  for (const key of ["fontSize", "outlineWidth", "shadowBlur", "shadowOffsetY", "highlightRadius"]) {
    if (typeof scaled[key] === "number") scaled[key] = Math.round(scaled[key] * scale);
  }
  return scaled;
}
