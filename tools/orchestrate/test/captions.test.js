import assert from "node:assert/strict";
import { test } from "node:test";

import { offsetWords } from "../captions.js";

test("a second clip's words are shifted onto the timeline", () => {
  const words = [{ text: "hello", startTime: 0.2, endTime: 0.6 }];
  assert.deepEqual(offsetWords(words, 24), [{ text: "hello", startTime: 24.2, endTime: 24.6 }]);
});

test("the first clip is not moved", () => {
  const words = [{ text: "hi", startTime: 0, endTime: 0.3 }];
  assert.deepEqual(offsetWords(words, 0), [{ text: "hi", startTime: 0, endTime: 0.3 }]);
});

test("blank and zero-length words are dropped rather than drawn", () => {
  const words = [
    { text: "  ", startTime: 1, endTime: 2 },
    { text: "ok", startTime: 2, endTime: 2 },
    { text: " kept ", startTime: 3, endTime: 3.4 },
  ];
  assert.deepEqual(offsetWords(words, 0), [{ text: "kept", startTime: 3, endTime: 3.4 }]);
});

test("floats are rounded, so the cue file does not carry whisper's noise", () => {
  const words = [{ text: "x", startTime: 0.1234567, endTime: 0.7654321 }];
  assert.deepEqual(offsetWords(words, 1.0000001), [{ text: "x", startTime: 1.123, endTime: 1.765 }]);
});
