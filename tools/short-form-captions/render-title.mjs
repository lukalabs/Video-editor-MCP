/**
 * Two-line end title that slides up into the upper third and holds.
 * Rendered as a transparent PNG sequence for ffmpeg to composite.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const puppeteer = (await import(process.env.PUPPETEER_CORE_PATH)).default;

const [, , outDir, optionsJson] = process.argv;
const o = JSON.parse(optionsJson);

const fontBase64 = readFileSync(o.fontPath).toString("base64");
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: o.chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300 });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family:"TitleFont"; src:url(data:font/otf;base64,${fontBase64}) format("opentype"); font-weight:100 900; }
    body{margin:0}
  </style></head><body></body></html>`);

  const ok = await page.evaluate(async (size) => {
    await document.fonts.load(`700 ${size}px "TitleFont"`);
    await document.fonts.ready;
    return document.fonts.check(`700 ${size}px "TitleFont"`);
  }, o.fontSize);
  if (!ok) throw new Error("TitleFont failed to load");

  await page.evaluate((opts) => {
    const canvas = document.createElement("canvas");
    canvas.width = opts.width;
    canvas.height = opts.height;
    document.body.appendChild(canvas);
    window.__c = canvas;
    window.__x = canvas.getContext("2d");
    window.__o = opts;
  }, o);

  const total = Math.ceil(o.duration * o.fps);
  const BATCH = 60;
  for (let start = 0; start < total; start += BATCH) {
    const end = Math.min(start + BATCH, total);
    const batch = await page.evaluate(
      (params) => {
        const { from, to } = params;
        const ctx = window.__x;
        const canvas = window.__c;
        const o = window.__o;
        const out = [];

        // Ease-out cubic: fast in, settles softly.
        // Ease-out quintic: long, soft deceleration into the resting place.
        const ease = (t) => 1 - Math.pow(1 - t, 5);

        for (let f = from; f < to; f++) {
          const t = f / o.fps;
          const p = Math.min(1, t / o.slideSeconds);
          const eased = ease(p);

          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const lineHeight = o.fontSize * 1.16;
          const restY = o.height * o.anchorY;
          // Travels up from below its resting place.
          const y = restY - (1 - eased) * o.travel;

          ctx.save();
          // Finish fading before the slide settles, so the landing reads as motion.
          ctx.globalAlpha = Math.min(1, eased / 0.6);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `700 ${o.fontSize}px "TitleFont"`;

          o.lines.forEach((line, i) => {
            ctx.fillStyle = line.color;
            ctx.fillText(line.text, canvas.width / 2, y + i * lineHeight);
          });

          ctx.restore();
          out.push(canvas.toDataURL("image/png").slice(22));
        }
        return out;
      },
      { from: start, to: end },
    );

    batch.forEach((data, i) => {
      writeFileSync(
        join(outDir, `f${String(start + i).padStart(6, "0")}.png`),
        Buffer.from(data, "base64"),
      );
    });
  }
  console.log(JSON.stringify({ frames: total }));
} finally {
  await browser.close();
}
