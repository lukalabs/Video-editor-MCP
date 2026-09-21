import { describe, expect, it } from "vitest";
import { paintSubtitle } from "./caption-painter";
import type { Subtitle } from "../types/timeline";

interface DrawnText {
  readonly text: string;
  readonly fillStyle: string;
  readonly x: number;
}

/** Minimal 2D context stub that records what was drawn. */
function createRecordingContext() {
  const drawn: DrawnText[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillRect() {},
    // Real canvas ignores trailing spaces when measuring; the stub must too.
    measureText: (text: string) => ({ width: text.replace(/\s+$/, "").length * 10 }),
    strokeText() {},
    fillText(text: string, x: number) {
      drawn.push({ text, fillStyle: String(ctx.fillStyle), x });
    },
  };
  return { ctx, drawn };
}

const WORDS_SUBTITLE: Subtitle = {
  id: "s1",
  text: "one two three",
  startTime: 0,
  endTime: 3,
  animationStyle: "word-highlight",
  words: [
    { text: "one", startTime: 0, endTime: 1 },
    { text: "two", startTime: 1, endTime: 2 },
    { text: "three", startTime: 2, endTime: 3 },
  ],
  style: {
    fontFamily: "Inter",
    fontSize: 32,
    color: "#ffffff",
    backgroundColor: "rgba(0,0,0,0.7)",
    position: "bottom",
    highlightColor: "#ff0000",
  },
};

describe("paintSubtitle", () => {
  it("draws each word separately and highlights the active one", () => {
    const { ctx, drawn } = createRecordingContext();

    paintSubtitle(ctx as never, WORDS_SUBTITLE, 1920, 1080, 1.5);

    expect(drawn.map((entry) => entry.text)).toEqual(["one", "two", "three"]);
    expect(drawn[1].fillStyle).toBe("#ff0000");
    expect(drawn[0].fillStyle).toBe("#ffffff");
    expect(drawn[2].fillStyle).toBe("#ffffff");
  });

  it("moves the highlight as time advances", () => {
    const first = createRecordingContext();
    const second = createRecordingContext();

    paintSubtitle(first.ctx as never, WORDS_SUBTITLE, 1920, 1080, 0.5);
    paintSubtitle(second.ctx as never, WORDS_SUBTITLE, 1920, 1080, 2.5);

    expect(first.drawn[0].fillStyle).toBe("#ff0000");
    expect(second.drawn[2].fillStyle).toBe("#ff0000");
  });

  it("draws whole lines when there is no animation", () => {
    const { ctx, drawn } = createRecordingContext();

    paintSubtitle(
      ctx as never,
      { ...WORDS_SUBTITLE, animationStyle: "none" },
      1920,
      1080,
      1.5,
    );

    expect(drawn.map((entry) => entry.text)).toEqual(["one two three"]);
  });

  it("leaves a space between words", () => {
    const { ctx, drawn } = createRecordingContext();

    paintSubtitle(ctx as never, WORDS_SUBTITLE, 1920, 1080, 1.5);

    // "one" is 3 chars * 10, so a gap of exactly 30 would mean no space at all.
    const gap = drawn[1].x - drawn[0].x;
    expect(gap).toBeGreaterThan(30);
  });

  it("keeps the settled slot while a word scales up from small", () => {
    const shrunk = createRecordingContext();
    const settled = createRecordingContext();

    // "bounce" scales each word up from 0.5 as it appears.
    const bouncing = { ...WORDS_SUBTITLE, animationStyle: "bounce" as const };
    paintSubtitle(shrunk.ctx as never, bouncing, 1920, 1080, 2.05);
    paintSubtitle(settled.ctx as never, bouncing, 1920, 1080, 2.9);

    // Word positions must not move as the bounce settles.
    expect(shrunk.drawn.map((entry) => entry.x)).toEqual(
      settled.drawn.map((entry) => entry.x),
    );
  });

  it("draws nothing for empty text", () => {
    const { ctx, drawn } = createRecordingContext();

    paintSubtitle(ctx as never, { ...WORDS_SUBTITLE, text: "  " }, 1920, 1080, 1);

    expect(drawn).toEqual([]);
  });
});
