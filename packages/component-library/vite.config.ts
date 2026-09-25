import ffmpegModule from "@motion-canvas/ffmpeg";
import motionCanvasModule from "@motion-canvas/vite-plugin";
import { defineConfig } from "vite";

// Both plugins are CJS, so under ESM config loading the callable lands on `.default`
// depending on how Vite bundles the config file. Normalise defensively.
const motionCanvas = (motionCanvasModule as never as { default?: unknown }).default ?? motionCanvasModule;
const ffmpeg = (ffmpegModule as never as { default?: unknown }).default ?? ffmpegModule;

export default defineConfig({
  plugins: [
    (motionCanvas as typeof motionCanvasModule)({
      project: [
        "./src/projects/stat-counter.ts",
        "./src/projects/button.ts",
        "./src/projects/button-pulse-glow.ts",
        "./src/projects/button-shimmer.ts",
        "./src/projects/button-outline-draw.ts",
        "./src/projects/button-fill-sweep.ts",
        "./src/projects/button-ghost-float.ts",
        "./src/projects/button-press-3d.ts",
        "./src/projects/button-bounce-in.ts",
        "./src/projects/button-blink-flash.ts",
        "./src/projects/button-gradient-flow.ts",
        "./src/projects/button-ripple-rings.ts",
        "./src/projects/turbulent-background-Rep.ts",
        "./src/projects/orbit-headline-Rep.ts",
        "./src/projects/chat-bubble-single-Rep.ts",
        "./src/projects/chat-thread-Rep.ts",
      ],
      output: "./output",
    }),
    // Bundled for completeness; the render pipeline uses the built-in image-sequence
    // exporter plus our own ffmpeg call, because this exporter hardcodes MP4/yuv420p
    // (see node_modules/@motion-canvas/ffmpeg/lib/server/FFmpegExporterServer.js) and
    // therefore cannot produce an alpha channel.
    (ffmpeg as typeof ffmpegModule)(),
  ],
  server: {
    port: 9000,
  },
});
