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

/**
 * Words the model says correctly but Whisper spells wrong, and what they should be.
 *
 * "Replika" and "replica" are the same sound, so the audio is right either way and
 * ugc-farm's own checker deliberately accepts either in a prompt (`HOMOPHONES` in
 * `ugc/writer.py`). Subtitles are not audio: whichever spelling Whisper picks is the
 * one people read, and a brand name misspelled across the whole video is the kind of
 * thing that is only noticed after it is posted.
 *
 * Case is preserved on the first letter so a word that opened a sentence still does.
 */
const HEARD_AS = [[/\breplicas\b/gi, "Replikas"], [/\breplica\b/gi, "Replika"]];

export function spellBrands(text) {
  let out = String(text ?? "");
  for (const [pattern, correct] of HEARD_AS) {
    out = out.replace(pattern, (match) => (
      // A lower-case hit mid-sentence still becomes the brand; the brand is a proper
      // noun, so there is no lower-case form of it to preserve.
      match === match.toUpperCase() && match.length > 1 ? correct.toUpperCase() : correct
    ));
  }
  return out;
}

/** Shift one clip's words onto the timeline. */
export function offsetWords(words, seconds) {
  return words.map((word) => ({
    text: spellBrands(String(word.text ?? "").trim()),
    startTime: round(Number(word.startTime) + seconds),
    endTime: round(Number(word.endTime) + seconds),
  })).filter((word) => word.text && word.endTime > word.startTime);
}

/**
 * @param {{clips: {file: string, at: number}[], repo: string, dir: string, log: Function}} options
 * @returns {string|null} the cue file, or null when there was nothing to hear
 */
export function transcribe({ clips, repo, dir, log, spoken = "" }) {
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
      // The script goes in as a decoding hint, not as the answer — see transcribe.py.
      sh(python, [script, wav, words, ...(spoken ? [spoken] : [])],
         { timeoutMs: 15 * 60 * 1000 });
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
