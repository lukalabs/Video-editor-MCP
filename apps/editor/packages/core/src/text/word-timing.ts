import type { SubtitleWord } from "../types/timeline";

/**
 * Estimated per-word timing for captions that have no real timestamps.
 *
 * Whisper can return true word-level timings, but nothing else can: an imported SRT
 * carries one time span per cue, and so does a caption typed by hand. Rather than
 * leaving those captions unanimated, the cue's duration is shared out across its
 * words in proportion to how long each word is, which tracks speech well enough to
 * read as deliberate - longer words genuinely do take longer to say.
 *
 * It is an estimate and drifts against real speech; the fix for that is real
 * timestamps, not a cleverer distribution. Whatever produces real ones should
 * overwrite these rather than merge with them.
 */

/**
 * Trailing punctuation is spoken as part of the word before it, and a lone "-"
 * is not spoken at all, so weighting by raw length would hand silent characters
 * their own slice of the clip.
 */
function spokenLength(word: string): number {
  const stripped = word.replace(/[.,!?;:"'`)(\][}{…—–-]+/gu, "");
  return Math.max(1, stripped.length);
}

export interface DeriveWordTimingsOptions {
  /** Where the returned times start. Clip-relative captions pass 0 (the default). */
  readonly startTime?: number;
}

/**
 * Splits `text` into words and spreads `duration` across them by spoken length.
 *
 * Returns an empty array for blank text or a non-positive duration - callers treat
 * "no words" as "draw the caption as plain text", which is the right outcome when
 * there is nothing sensible to time.
 */
export function deriveWordTimings(
  text: string,
  duration: number,
  options: DeriveWordTimingsOptions = {},
): SubtitleWord[] {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0 || !Number.isFinite(duration) || duration <= 0) {
    return [];
  }

  const startTime = options.startTime ?? 0;
  const weights = words.map(spokenLength);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  const timed: SubtitleWord[] = [];
  let elapsed = 0;

  for (let i = 0; i < words.length; i++) {
    const share = (weights[i] / totalWeight) * duration;
    const wordStart = startTime + elapsed;
    elapsed += share;
    // The last word ends exactly on the caption's end: accumulated floating point
    // error must not leave a sliver in which no word is active.
    const wordEnd =
      i === words.length - 1 ? startTime + duration : startTime + elapsed;
    timed.push({ text: words[i], startTime: wordStart, endTime: wordEnd });
  }

  return timed;
}
