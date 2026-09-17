"""Word-level transcription with faster-whisper.

whisper.cpp's word timings drifted badly on these clips and its --dtw
alignment reported nothing, so alignment is done here instead.
"""

import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel

MODEL_SIZE = "large-v3"

# Words at the start of a sentence are capitalised for grammar, not because they are
# names, so they are no evidence of anything and are skipped.
SENTENCE_END = (".", "!", "?", "…")


def names(script: str) -> str:
    """The proper nouns in a script — the words Whisper has no reason to know.

    Capitalised mid-sentence is the whole test. It is a weak signal and it does not
    need to be strong: a word wrongly included is one Whisper was going to spell
    correctly anyway, and the cost of missing one is a brand name misspelt across
    every frame of the video.
    """
    found, starts_sentence = [], True
    for token in script.split():
        word = token.strip("\"'()[],;:")
        if word and word[0].isupper() and not starts_sentence and word.lower() != "i":
            found.append(word.rstrip("".join(SENTENCE_END)))
        starts_sentence = token.endswith(SENTENCE_END)
    return " ".join(dict.fromkeys(found))


def main():
    audio_path, out_path = sys.argv[1], sys.argv[2]
    # What she was scripted to say, when the caller knows. Whisper is decoding four
    # seconds of one voice with no context, and on a made-up proper noun it guesses
    # from sound alone — "Replika" came back as "replica", and once as "repeat A".
    # The script is not a transcript and is never treated as one: it only biases the
    # decode, so an ad-lib or a dropped word still transcribes as whatever was said.
    said = sys.argv[3].strip() if len(sys.argv) > 3 else ""

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        # Both, because neither works alone — measured on a clip that came back as
        # "My repeat A remembers everything". The prompt alone and the hotwords alone
        # each left it wrong; together they give "My Replika remembers everything".
        # The hotwords must be the names only: passing the whole script as hotwords
        # dilutes them and made the same clip decode as "Repeatae".
        initial_prompt=said or None,
        hotwords=names(said) or None,
    )

    words = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append(
                    {"text": text, "startTime": word.start, "endTime": word.end}
                )

    Path(out_path).write_text(json.dumps(words, indent=2))
    span = f"{words[0]['startTime']:.2f}-{words[-1]['endTime']:.2f}s" if words else "empty"
    print(f"{Path(audio_path).stem}: {len(words)} words, {span}")


if __name__ == "__main__":
    main()
