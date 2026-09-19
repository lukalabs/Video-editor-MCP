import { describe, it, expect } from "vitest";
import { deriveWordTimings } from "./word-timing";

/**
 * Proportional timings are what captions without real transcription get, so the
 * guarantees that matter are structural: the words tile the caption with no gaps,
 * every word is active at some point, and longer words get longer.
 */

describe("deriveWordTimings", () => {
  it("covers the whole caption with no gaps between words", () => {
    const words = deriveWordTimings("one two three", 3);

    expect(words[0].startTime).toBe(0);
    expect(words.at(-1)!.endTime).toBe(3);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startTime).toBeCloseTo(words[i - 1].endTime, 10);
    }
  });

  it("gives a longer word a longer slice", () => {
    const [short, long] = deriveWordTimings("hi extraordinary", 10);

    const shortSpan = short.endTime - short.startTime;
    const longSpan = long.endTime - long.startTime;
    expect(longSpan).toBeGreaterThan(shortSpan);
  });

  it("splits evenly when the words are the same length", () => {
    const words = deriveWordTimings("aaa bbb ccc", 3);

    expect(words.map((w) => w.startTime)).toEqual([0, 1, 2]);
    expect(words.map((w) => w.endTime)).toEqual([1, 2, 3]);
  });

  it("ignores punctuation when weighting, so a comma does not buy time", () => {
    const withComma = deriveWordTimings("hello, world", 2);
    const without = deriveWordTimings("hello world", 2);

    expect(withComma[0].endTime).toBeCloseTo(without[0].endTime, 10);
  });

  it("lands the final word exactly on the caption end", () => {
    // Seven words over an awkward duration: accumulated rounding must not leave a
    // sliver at the end where no word is active.
    const words = deriveWordTimings("a bb ccc dddd e ff ggg", 3.7777);

    expect(words.at(-1)!.endTime).toBe(3.7777);
  });

  it("offsets every word when a start time is given", () => {
    const words = deriveWordTimings("one two", 2, { startTime: 5 });

    expect(words[0].startTime).toBe(5);
    expect(words.at(-1)!.endTime).toBe(7);
  });

  it("leaves a word active at every instant inside the caption", () => {
    const words = deriveWordTimings("the quick brown fox jumps", 5);

    for (const t of [0, 0.4, 1.1, 2.5, 3.9, 4.99]) {
      const active = words.find((w) => t >= w.startTime && t < w.endTime);
      expect(active, `no active word at ${t}s`).toBeDefined();
    }
  });

  it("returns nothing for blank text or a zero-length caption", () => {
    expect(deriveWordTimings("", 3)).toEqual([]);
    expect(deriveWordTimings("   ", 3)).toEqual([]);
    expect(deriveWordTimings("hello", 0)).toEqual([]);
    expect(deriveWordTimings("hello", -1)).toEqual([]);
  });

  it("handles a single word by giving it the whole caption", () => {
    expect(deriveWordTimings("solo", 2)).toEqual([
      { text: "solo", startTime: 0, endTime: 2 },
    ]);
  });

  it("collapses runs of whitespace rather than timing empty words", () => {
    const words = deriveWordTimings("one    two\n\nthree", 3);

    expect(words.map((w) => w.text)).toEqual(["one", "two", "three"]);
  });
});
