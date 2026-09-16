/**
 * The words, and when each one is said.
 *
 * Whisper hears one clip at a time, so a video split across several renders comes
 * back as several word lists, each timed from its own zero. They are shifted by
 * where their clip sits on the timeline and concatenated into one list.
 *
 * That list goes to project-cli as-is. Its `loadCues` recognises a raw word list
 * and groups it into short cues itself, with the same rules `build_cues.py` uses —
 * so there is no reason to run that script as well.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { StepError, round, sh } from "./lib.js";

export const whisperPython = (repo) => resolve(repo, "storage/caption-work/venv/bin/python");

/** Shift one clip's words onto the timeline. */
export function offsetWords(words, seconds) {
  return words.map((word) => ({
    text: String(word.text ?? "").trim(),
    startTime: round(Number(word.startTime) + seconds),
    endTime: round(Number(word.endTime) + seconds),
  })).filter((word) => word.text && word.endTime > word.startTime);
}

/**
 * @param {{clips: {file: string, at: number}[], repo: string, dir: string, log: Function}} options
 * @returns {string|null} the cue file, or null when there was nothing to hear
 */
export function transcribe({ clips, repo, dir, log }) {
  const python = whisperPython(repo);
  if (!existsSync(python)) {
    throw new StepError("the whisper virtualenv is missing", {
      hint: "python3 -m venv storage/caption-work/venv && "
        + "storage/caption-work/venv/bin/pip install -r tools/short-form-captions/requirements.txt",
    });
  }
  const script = resolve(repo, "tools/short-form-captions/transcribe.py");
  const all = [];

  clips.forEach((clip, index) => {
    const part = index + 1;
    const wav = join(dir, `audio-${part}.wav`);
    const words = join(dir, `words-${part}.json`);

    if (!existsSync(wav)) {
      sh("ffmpeg", ["-v", "error", "-y", "-i", clip.file,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    }
    if (!existsSync(words)) {
      // The first ever run downloads the large-v3 weights, about 3 GB, and looks
      // exactly like a hang. Say so before going quiet.
      log(`  part ${part}  listening…  (int8 large-v3 on CPU, roughly 2-4x the clip's length)`);
      sh(python, [script, wav, words], { timeoutMs: 15 * 60 * 1000 });
    }

    const heard = JSON.parse(readFileSync(words, "utf8"));
    log(`  part ${part}  ${heard.length} words`);
    all.push(...offsetWords(heard, clip.at));
  });

  if (!all.length) {
    // project-cli throws "cue file must be a non-empty array", which explains
    // nothing. Better to skip the step and say why.
    log("  nothing was heard in any clip — skipping captions");
    return null;
  }

  const cues = join(dir, "cues.json");
  writeFileSync(cues, `${JSON.stringify(all, null, 2)}\n`);
  log(`  ${all.length} words across ${clips.length} clip(s) -> ${cues}`);
  return cues;
}
