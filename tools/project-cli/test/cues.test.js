import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCues } from "../cues.js";
import { CAPTION_PRESETS, scalePreset } from "../presets.js";

const WORDS = [
  { text: "I", startTime: 0, endTime: 0.2 },
  { text: "almost", startTime: 0.2, endTime: 0.6 },
  { text: "gave", startTime: 0.6, endTime: 0.9 },
  { text: "up", startTime: 0.9, endTime: 1.1 },
  { text: "on", startTime: 1.1, endTime: 1.3 },
  { text: "companions.", startTime: 1.3, endTime: 2.0 },
];

test("groups a raw word list into short cues", () => {
  const cues = loadCues(WORDS);

  assert.ok(cues.length > 1, "a six-word line becomes more than one cue");
  for (const cue of cues) {
    assert.ok(cue.text.length <= 20, `"${cue.text}" is within the character cap`);
    assert.ok(cue.words.length <= 4, "at most four words per cue");
    assert.ok(cue.endTime > cue.startTime);
  }
  // No word is lost or reordered.
  assert.deepEqual(
    cues.flatMap((cue) => cue.words.map((word) => word.text)),
    WORDS.map((word) => word.text),
  );
});

test("passes pre-grouped cues through untouched", () => {
  const grouped = [
    { text: "already grouped", startTime: 0, endTime: 1, words: [{ text: "already", startTime: 0, endTime: 0.5 }] },
  ];
  assert.deepEqual(loadCues(grouped), grouped);
});

test("uppercase applies to the cue and its words together", () => {
  const [cue] = loadCues(
    [{ text: "make it", startTime: 0, endTime: 1, words: [{ text: "make", startTime: 0, endTime: 1 }] }],
    { uppercase: true },
  );
  assert.equal(cue.text, "MAKE IT");
  assert.equal(cue.words[0].text, "MAKE");
});

test("rejects an empty cue file", () => {
  assert.throws(() => loadCues([]), /non-empty array/);
});

test("scalePreset scales pixel sizes to the real frame width", () => {
  const preset = CAPTION_PRESETS.hormozi;
  const full = scalePreset(preset, 1080);
  const half = scalePreset(preset, 540);

  assert.equal(full.fontSize, preset.style.fontSize, "the reference width is unchanged");
  assert.equal(half.fontSize, Math.round(preset.style.fontSize / 2));
  assert.equal(half.outlineWidth, Math.round(preset.style.outlineWidth / 2));
  assert.equal(half.color, preset.style.color, "colours are not scaled");
});

test("every preset names an animation the renderer implements", () => {
  const known = ["none", "word-highlight", "word-by-word", "karaoke", "bounce", "typewriter"];
  for (const [name, preset] of Object.entries(CAPTION_PRESETS)) {
    assert.ok(known.includes(preset.animationStyle), `${name} uses a known animationStyle`);
    assert.ok(preset.style.fontFamily, `${name} names a font family`);
  }
});

test("every animated preset names its own highlight colour", () => {
  // The renderer falls back to yellow for an active word, so a preset that animates
  // words must say what colour it wants or the yellow leaks through.
  const animatesWords = ["word-highlight", "word-by-word", "karaoke", "bounce"];
  for (const [name, preset] of Object.entries(CAPTION_PRESETS)) {
    if (!animatesWords.includes(preset.animationStyle)) continue;
    assert.ok(
      preset.style.highlightColor,
      `${name} animates words, so it must set highlightColor`,
    );
  }
});
