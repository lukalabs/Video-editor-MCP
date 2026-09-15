/**
 * Render karaoke caption frames with the editor's own paintSubtitle, so the
 * burned-in result matches what the editor preview shows.
 *
 * Only a horizontal band around the captions is drawn; ffmpeg overlays that
 * band back at the right offset, which keeps the PNGs small.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
// puppeteer-core lives in render-service, not next to this script.
const puppeteer = (await import(process.env.PUPPETEER_CORE_PATH)).default;

const [, , cuesPath, outDir, optionsJson] = process.argv;
const options = JSON.parse(optionsJson);
const { width, height, fps, duration, fontSize, bandHeight, chromePath, fontPath, painterPath } = options;
const verticalAnchor = options.verticalAnchor ?? 0.74;

const cues = JSON.parse(readFileSync(cuesPath, "utf8"));
const painterSource = readFileSync(painterPath, "utf8");
const fontBase64 = readFileSync(fontPath).toString("base64");

const VERTICAL_ANCHOR = verticalAnchor;
const bandTop = Math.round(height * VERTICAL_ANCHOR - bandHeight / 2);

const preset = options.preset;

const STYLE = {
  fontFamily: "CaptionFont",
  fontWeight: "800",
  fontSize,
  color: preset.color,
  highlightColor: preset.highlightColor,
  upcomingColor: preset.upcomingColor,
  backgroundColor: preset.backgroundColor ?? "rgba(0,0,0,0)",
  position: "center",
  verticalAnchor: VERTICAL_ANCHOR,
  highlightBackgroundColor: preset.highlightBackgroundColor,
  highlightRadius: preset.highlightRadius ?? 0,
  outlineColor: preset.outlineColor ?? "#000000",
  outlineWidth: Math.round(fontSize * (preset.outlineScale ?? 0.14)),
  shadowColor: preset.shadowColor ?? "rgba(0,0,0,0.55)",
  shadowBlur: Math.round(fontSize * 0.11),
  shadowOffsetY: Math.round(fontSize * 0.06),
};

const toCase = (value) => (preset.uppercase ? value.toUpperCase() : value);

const subtitles = cues.map((cue) => ({
  ...cue,
  text: toCase(cue.text),
  words: cue.words.map((word) => ({ ...word, text: toCase(word.text) })),
  animationStyle: preset.animationStyle,
  style: STYLE,
}));

mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300 });

  await page.setContent(`<!doctype html><html><head><style>
    @font-face {
      font-family: "CaptionFont";
      src: url(data:font/ttf;base64,${fontBase64}) format("truetype");
      font-weight: 100 900;
    }
    body { margin: 0; }
  </style></head><body></body></html>`);

  // Canvas will silently fall back unless the face is actually loaded first.
  const fontLoaded = await page.evaluate(async (size) => {
    await document.fonts.load(`800 ${size}px "CaptionFont"`);
    await document.fonts.ready;
    return document.fonts.check(`800 ${size}px "CaptionFont"`);
  }, fontSize);
  if (!fontLoaded) throw new Error("CaptionFont failed to load in the browser");

  // The bundle is an ES module, so re-expose paintSubtitle on window.
  await page.evaluate(
    (source) => {
      const stripped = source.replace(/export\s*\{[^}]*\};?/g, "");
      const factory = new Function(`${stripped}; return paintSubtitle;`);
      window.__paintSubtitle = factory();
    },
    painterSource,
  );

  // Captions are drawn on one line with no wrapping, so shrink the font until
  // the widest cue fits inside the safe width.
  const SAFE_WIDTH_RATIO = 0.9;
  const fittedFontSize = await page.evaluate(
    (params) => {
      const { texts, size, weight, maxWidth } = params;
      const probe = document.createElement("canvas").getContext("2d");
      probe.font = weight + " " + size + 'px "CaptionFont"';
      let widest = 0;
      for (const text of texts) {
        // Allow for the active word's 1.15 pop and any highlight padding.
        widest = Math.max(widest, probe.measureText(text).width * 1.12);
      }
      if (widest <= maxWidth) return size;
      return Math.floor(size * (maxWidth / widest));
    },
    {
      texts: subtitles.map((cue) => cue.text),
      size: fontSize,
      weight: STYLE.fontWeight,
      maxWidth: width * SAFE_WIDTH_RATIO,
    },
  );

  if (fittedFontSize !== fontSize) {
    STYLE.fontSize = fittedFontSize;
    STYLE.outlineWidth = Math.round(
      fittedFontSize * (preset.outlineScale ?? 0.14),
    );
    STYLE.shadowBlur = Math.round(fittedFontSize * 0.11);
    STYLE.shadowOffsetY = Math.round(fittedFontSize * 0.06);
  }

  await page.evaluate(
    (opts) => {
      const canvas = document.createElement("canvas");
      canvas.width = opts.width;
      canvas.height = opts.bandHeight;
      document.body.appendChild(canvas);
      window.__canvas = canvas;
      window.__ctx = canvas.getContext("2d");
      window.__opts = opts;
    },
    { width, height, bandHeight, bandTop },
  );

  const blankBase64 = await page.evaluate(() => {
    const canvas = window.__canvas;
    window.__ctx.clearRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  });
  const BLANK_PNG = Buffer.from(blankBase64, "base64");

  const totalFrames = Math.ceil(duration * fps);
  const BATCH = 120;
  let written = 0;
  let blankFrames = 0;

  for (let start = 0; start < totalFrames; start += BATCH) {
    const end = Math.min(start + BATCH, totalFrames);

    const batch = await page.evaluate(
      (params) => {
        const { subtitles, fps, from, to } = params;
        const ctx = window.__ctx;
        const canvas = window.__canvas;
        const { height, bandTop } = window.__opts;
        const out = [];

        for (let frame = from; frame < to; frame++) {
          const time = frame / fps;
          const active = subtitles.find(
            (cue) => time >= cue.startTime && time <= cue.endTime,
          );

          if (!active) {
            out.push(null);
            continue;
          }

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.save();
          // Shift the full-frame coordinate space up into the band.
          ctx.translate(0, -bandTop);
          window.__paintSubtitle(ctx, active, canvas.width, height, time);
          ctx.restore();

          out.push(canvas.toDataURL("image/png").slice("data:image/png;base64,".length));
        }
        return out;
      },
      { subtitles, fps, from: start, to: end },
    );

    batch.forEach((data, index) => {
      const frame = start + index;
      const file = join(outDir, `f${String(frame).padStart(6, "0")}.png`);
      if (data === null) {
        blankFrames++;
        writeFileSync(file, BLANK_PNG);
      } else {
        writeFileSync(file, Buffer.from(data, "base64"));
        written++;
      }
    });
  }

  console.log(
    JSON.stringify({ totalFrames, captionFrames: written, blankFrames, bandTop, bandHeight }),
  );
} finally {
  await browser.close();
}
