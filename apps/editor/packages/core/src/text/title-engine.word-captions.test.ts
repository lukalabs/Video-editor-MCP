import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleEngine } from "./title-engine";
import type { SubtitleWord, CaptionAnimationStyle } from "../types/timeline";

/**
 * Word-timed captions are drawn by the title engine, which BOTH the live preview and
 * the export render text through. That shared placement is the point: the animated
 * caption renderer used to be wired into the preview canvas only, so captions
 * animated on screen and exported as flat text.
 */

interface DrawnWord {
  readonly text: string;
  readonly fillStyle: string;
  readonly alpha: number;
  readonly textAlign: string;
}

interface StrokedWord {
  readonly text: string;
  readonly x: number;
  readonly textAlign: string;
}

function mountCanvas() {
  const drawn: DrawnWord[] = [];
  const stroked: StrokedWord[] = [];
  const scaleCalls: Array<[number, number]> = [];

  const ctx = {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn((x: number, y: number) => {
      scaleCalls.push([x, y]);
    }),
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    fillRect: vi.fn(),
    strokeText: vi.fn((text: string, x: number) => {
      stroked.push({ text, x, textAlign: ctx.textAlign });
    }),
    fillText: vi.fn((text: string) => {
      drawn.push({
        text,
        fillStyle: ctx.fillStyle,
        alpha: ctx.globalAlpha,
        textAlign: ctx.textAlign,
      });
    }),
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    textAlign: "center",
    textBaseline: "middle",
    globalAlpha: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    letterSpacing: "0px",
  };

  class MockOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return ctx;
    }
  }

  vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
  return { ctx, drawn, stroked, scaleCalls };
}

const WORDS: SubtitleWord[] = [
  { text: "one", startTime: 0, endTime: 1 },
  { text: "two", startTime: 1, endTime: 2 },
  { text: "three", startTime: 2, endTime: 3 },
];

function captionClip(
  engine: TitleEngine,
  animationStyle: CaptionAnimationStyle,
  words: SubtitleWord[] = WORDS,
) {
  const clip = engine.createTextClip({
    trackId: "captions",
    startTime: 4, // deliberately not zero: word times are clip-relative
    duration: 3,
    text: "one two three",
    style: { fontSize: 48, color: "#ffffff", highlightColor: "#ffff00" },
  });
  return { ...clip, duration: 3, words, animationStyle };
}

describe("TitleEngine word-timed captions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("colours the word being spoken and leaves the others alone", () => {
    const { drawn } = mountCanvas();
    const engine = new TitleEngine();
    const clip = captionClip(engine, "word-highlight");

    // Clip-local 1.5s: the second word is active.
    engine.renderText(clip, 1920, 1080, 1.5);

    expect(drawn.map((d) => d.text)).toEqual(["one", "two", "three"]);
    expect(drawn[1].fillStyle).toBe("#ffff00");
    expect(drawn[0].fillStyle).toBe("#ffffff");
    expect(drawn[2].fillStyle).toBe("#ffffff");
  });

  it("moves the highlight on as time advances", () => {
    const { drawn } = mountCanvas();
    const engine = new TitleEngine();
    const clip = captionClip(engine, "word-highlight");

    engine.renderText(clip, 1920, 1080, 2.5);

    expect(drawn[2].fillStyle).toBe("#ffff00");
    expect(drawn[1].fillStyle).toBe("#ffffff");
  });

  it("treats word times as clip-relative, not timeline-absolute", () => {
    const { drawn } = mountCanvas();
    const engine = new TitleEngine();
    // The clip starts at 4s on the timeline. A local time of 0.5 must highlight the
    // FIRST word - if the engine were treating the words as absolute it would find
    // nothing active here and highlight none of them.
    const clip = captionClip(engine, "word-highlight");

    engine.renderText(clip, 1920, 1080, 0.5);

    expect(drawn[0].fillStyle).toBe("#ffff00");
  });

  it("shows only the active word for word-by-word", () => {
    const { drawn } = mountCanvas();
    const engine = new TitleEngine();
    const clip = captionClip(engine, "word-by-word");

    engine.renderText(clip, 1920, 1080, 1.5);

    expect(drawn.map((d) => d.text)).toEqual(["two"]);
  });

  it("reveals words progressively for typewriter", () => {
    const { drawn } = mountCanvas();
    const engine = new TitleEngine();
    const clip = captionClip(engine, "typewriter");

    engine.renderText(clip, 1920, 1080, 1.5);

    expect(drawn.map((d) => d.text)).toEqual(["one", "two"]);
  });

  it("scales the highlighted word without shifting the others", () => {
    const { drawn, scaleCalls } = mountCanvas();
    const engine = new TitleEngine();
    const clip = captionClip(engine, "word-highlight");

    engine.renderText(clip, 1920, 1080, 1.5);

    // One scale for the clip transform, then one per word; the active word is the
    // only one scaled above 1.
    const wordScales = scaleCalls.slice(1).map(([x]) => x);
    expect(wordScales).toHaveLength(3);
    expect(wordScales[1]).toBeGreaterThan(1);
    expect(wordScales[0]).toBe(1);
    expect(wordScales[2]).toBe(1);
    expect(drawn).toHaveLength(3);
  });

  it("draws the outline left-aligned, like the fill, so it lands on the same word", () => {
    const { drawn, stroked } = mountCanvas();
    const engine = new TitleEngine();
    const base = captionClip(engine, "word-highlight");
    const clip = {
      ...base,
      style: { ...base.style, strokeColor: "#111827", strokeWidth: 2 },
    };

    engine.renderText(clip, 1920, 1080, 1.5);

    // The positions are left edges. A stroke drawn while textAlign is still the
    // style's "center" renders half a word to the left of its fill - a ghost
    // outline of the whole caption, which is what shipped the first time.
    expect(stroked).toHaveLength(3);
    for (const outline of stroked) {
      expect(outline.textAlign).toBe("left");
    }
    for (const word of drawn) {
      expect(word.textAlign).toBe("left");
    }
    expect(stroked.map((s) => s.text)).toEqual(drawn.map((d) => d.text));
  });

  it("falls back to plain text when the clip has no words", () => {
    const { drawn } = mountCanvas();
    const engine = new TitleEngine();
    const clip = captionClip(engine, "word-highlight", []);

    engine.renderText(clip, 1920, 1080, 1.5);

    expect(drawn.map((d) => d.text)).toEqual(["one two three"]);
  });

  it("falls back to plain text when no animation style is set", () => {
    const { drawn } = mountCanvas();
    const engine = new TitleEngine();
    const clip = captionClip(engine, "none");

    engine.renderText(clip, 1920, 1080, 1.5);

    expect(drawn.map((d) => d.text)).toEqual(["one two three"]);
  });
});
