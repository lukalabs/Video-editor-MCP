"""Word-level transcription with faster-whisper.

whisper.cpp's word timings drifted badly on these clips and its --dtw
alignment reported nothing, so alignment is done here instead.
"""

import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel

MODEL_SIZE = "large-v3"


def main():
    audio_path, out_path = sys.argv[1], sys.argv[2]

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
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
