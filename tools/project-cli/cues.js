/**
 * Converts caption cue files into the editor's Subtitle shape.
 *
 * Accepts either the grouped cues written by tools/short-form-captions/build_cues.py
 * (`[{text, startTime, endTime, words}]`) or a raw word list from transcribe.py
 * (`[{text, startTime, endTime}]`), which is grouped on the fly.
 */

const MAX_WORDS = 4;
const MAX_CHARS = 20;
const GAP_SPLIT = 0.45;
const MIN_DURATION = 0.3;
const SENTENCE_END = [".", "!", "?"];

function looksLikeWordList(entries) {
  // Grouped cues carry a `words` array; a raw word list does not.
  return entries.every((entry) => entry.words === undefined);
}

function groupWords(words) {
  const cues = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    const startTime = current[0].startTime;
    cues.push({
      text: current.map((word) => word.text).join(" "),
      startTime,
      endTime: Math.max(current[current.length - 1].endTime, startTime + MIN_DURATION),
      words: current.map((word) => ({ ...word })),
    });
    current = [];
  };

  for (const word of words) {
    if (current.length > 0) {
      const previous = current[current.length - 1];
      const candidate = `${current.map((w) => w.text).join(" ")} ${word.text}`;
      const endsSentence = SENTENCE_END.some((mark) => previous.text.endsWith(mark));
      if (
        word.startTime - previous.endTime > GAP_SPLIT ||
        current.length >= MAX_WORDS ||
        candidate.length > MAX_CHARS ||
        endsSentence
      ) {
        flush();
      }
    }
    current.push(word);
  }
  flush();

  // Hold each cue until the next begins, so captions do not flicker off between words.
  cues.forEach((cue, index) => {
    const next = cues[index + 1];
    if (next) cue.endTime = Math.min(next.startTime, cue.endTime + 0.35);
  });

  return cues;
}

export function loadCues(json, { uppercase = false } = {}) {
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error("cue file must be a non-empty array");
  }

  const cues = looksLikeWordList(json) ? groupWords(json) : json;
  const cased = (value) => (uppercase ? value.toUpperCase() : value);

  return cues.map((cue) => ({
    text: cased(cue.text),
    startTime: cue.startTime,
    endTime: cue.endTime,
    ...(cue.words
      ? { words: cue.words.map((word) => ({ ...word, text: cased(word.text) })) }
      : {}),
  }));
}
