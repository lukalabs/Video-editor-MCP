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
/**
 * How much of the frame a caption line may use. The rest is breathing room, and on
 * a phone it is also where the platform puts its own interface.
 */
const SAFE_WIDTH = 0.9;

/**
 * Average width of one upper-case character, as a fraction of the font size.
 *
 * Measured, not guessed: "MY REPLIKA REMEMBERS" in Montserrat Black at 84px renders
 * 1162px wide, which is 1162 / (20 x 84) = 0.69. The bold faces these presets use
 * (Montserrat Black, Poppins Black, Inter Black) are close enough to share it.
 *
 * It is an average, so a line of nothing but W still overflows. That is the right
 * trade: sizing for the widest possible character would leave every ordinary line
 * looking half-size.
 */
const CHAR_WIDTH_EM = 0.69;

/**
 * The longest line, in characters, that fits the frame at this size.
 *
 * The caption grouper needs a character count and the canvas has a width, so one has
 * to be converted into the other somewhere. Doing it here means changing a preset's
 * font size moves the limit with it, instead of leaving two numbers to drift apart —
 * which is what put a 1162px line on a 1080px canvas.
 */
export function charsThatFit(fontSize, frameWidth) {
  return Math.max(6, Math.floor((frameWidth * SAFE_WIDTH) / (fontSize * CHAR_WIDTH_EM)));
}

export function scalePreset(preset, frameWidth) {
  const scale = frameWidth / 1080;
  if (scale === 1) return preset.style;

  const scaled = { ...preset.style };
  for (const key of ["fontSize", "outlineWidth", "shadowBlur", "shadowOffsetY", "highlightRadius"]) {
    if (typeof scaled[key] === "number") scaled[key] = Math.round(scaled[key] * scale);
  }
  return scaled;
}
