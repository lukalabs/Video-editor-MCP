"""Turn whisper.cpp word-level JSON into the editor's Subtitle cue shape.

whisper.cpp is run with `-ml 1 -sow`, so every segment holds exactly one word.
Words are regrouped into short karaoke cues: at most MAX_WORDS words and
MAX_CHARS characters, and a pause longer than GAP_SPLIT starts a new cue.
"""

import json
import sys
from pathlib import Path

MAX_WORDS = 4
MAX_CHARS = 20
GAP_SPLIT = 0.45          # seconds of silence that force a new cue
MIN_CUE_DURATION = 0.30   # stop single short words flashing past
SENTENCE_END = (".", "!", "?")


def parse_timestamp(value):
    """whisper.cpp writes offsets in milliseconds under `offsets`."""
    return value / 1000.0


def load_words(json_path):
    """Accepts the flat word list written by transcribe.py."""
    data = json.loads(Path(json_path).read_text())
    return [
        {
            "text": word["text"].strip(),
            "startTime": word["startTime"],
            "endTime": word["endTime"],
        }
        for word in data
        if word["text"].strip()
    ]


def group_into_cues(words):
    cues = []
    current = []

    def flush():
        if not current:
            return
        start = current[0]["startTime"]
        end = max(current[-1]["endTime"], start + MIN_CUE_DURATION)
        cues.append(
            {
                "text": " ".join(word["text"] for word in current),
                "startTime": start,
                "endTime": end,
                "words": [dict(word) for word in current],
            }
        )
        current.clear()

    for word in words:
        if current:
            gap = word["startTime"] - current[-1]["endTime"]
            candidate = " ".join(w["text"] for w in current) + " " + word["text"]
            if (
                gap > GAP_SPLIT
                or len(current) >= MAX_WORDS
                or len(candidate) > MAX_CHARS
                or current[-1]["text"].endswith(SENTENCE_END)
            ):
                flush()
        current.append(word)

    flush()

    # Hold each cue until the next one starts so there is no blank flicker.
    for index, cue in enumerate(cues):
        if index + 1 < len(cues):
            cue["endTime"] = min(cues[index + 1]["startTime"], cue["endTime"] + 0.35)

    return cues


def main():
    json_path, out_path = sys.argv[1], sys.argv[2]
    words = load_words(json_path)
    cues = group_into_cues(words)

    for index, cue in enumerate(cues):
        cue["id"] = f"cue-{index:04d}"

    Path(out_path).write_text(json.dumps(cues, indent=2))
    total = sum(len(cue["words"]) for cue in cues)
    print(f"{Path(json_path).stem}: {total} words -> {len(cues)} cues")


if __name__ == "__main__":
    main()
