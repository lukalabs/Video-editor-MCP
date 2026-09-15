#!/usr/bin/env bash
# Caption one vertical clip and burn on its end card.
#
#   ./run.sh <clip.mp4> <preset-key> [work-dir]
#
# Preset keys come from presets.json. See README.md for prerequisites.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

CLIP="${1:?usage: run.sh <clip.mp4> <preset-key> [work-dir]}"
PRESET="${2:?usage: run.sh <clip.mp4> <preset-key> [work-dir]}"
WORK="${3:-$REPO/storage/caption-work}"

NAME="$(basename "$CLIP" .mp4)"
VENV="$WORK/venv"
CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PUPPETEER="file://$REPO/apps/render-service/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"

mkdir -p "$WORK"/{audio,cues,frames,grad,cta,out}

# 1. One-time Python environment for transcription.
if [ ! -x "$VENV/bin/python" ]; then
  echo "[setup] creating venv"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$HERE/requirements.txt"
fi

# 2. Probe the clip; every later step is sized from these.
IFS=, read -r WIDTH HEIGHT < <(ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height -of csv=p=0 "$CLIP")
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIP")"
echo "[probe] ${WIDTH}x${HEIGHT}, ${DURATION}s"

# 3. Word-level transcription, then group words into karaoke cues.
ffmpeg -v error -y -i "$CLIP" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/audio/$NAME.wav"
"$VENV/bin/python" "$HERE/transcribe.py" "$WORK/audio/$NAME.wav" "$WORK/cues/$NAME-words.json"
python3 "$HERE/build_cues.py" "$WORK/cues/$NAME-words.json" "$WORK/cues/$NAME-cues.json"

# 4. Caption frames, drawn by the editor's own paintSubtitle.
PAINTER="$WORK/caption-painter.js"
ESBUILD="$(ls -d "$REPO"/apps/editor/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)"
"$ESBUILD" "$REPO/apps/editor/packages/core/src/text/caption-painter.ts" \
  --bundle --format=esm --outfile="$PAINTER" >/dev/null

CAPTION_OPTS="$(python3 - "$HERE/presets.json" "$PRESET" "$WIDTH" "$HEIGHT" "$DURATION" "$PAINTER" "$CHROME" <<'PY'
import json, sys
presets_path, key, width, height, duration, painter, chrome = sys.argv[1:8]
preset = json.load(open(presets_path))[key]
scale = int(width) / 1080
print(json.dumps({
    "width": int(width), "height": int(height), "fps": 24,
    "duration": float(duration),
    "fontSize": round(preset["fontSize"] * scale),
    "bandHeight": round(preset["bandHeight"] * scale),
    "verticalAnchor": 0.74,
    "chromePath": chrome,
    "fontPath": f"{__import__('os').path.expanduser('~')}/Library/Fonts/{preset['font']}",
    "painterPath": painter,
    "preset": preset["preset"],
}))
PY
)"
PUPPETEER_CORE_PATH="$PUPPETEER" node "$HERE/render-captions.mjs" \
  "$WORK/cues/$NAME-cues.json" "$WORK/frames/$NAME" "$CAPTION_OPTS"

BAND_TOP="$(python3 -c "
import json,sys
p=json.load(open('$HERE/presets.json'))['$PRESET']
scale=$WIDTH/1080
print(round($HEIGHT*0.74 - round(p['bandHeight']*scale)/2))
")"

ffmpeg -v error -y -i "$CLIP" -framerate 24 -i "$WORK/frames/$NAME/f%06d.png" \
  -filter_complex "[0:v][1:v]overlay=0:$BAND_TOP:format=auto,format=yuv420p" \
  -c:v libx264 -preset medium -crf 18 -movflags +faststart -c:a copy \
  "$WORK/out/$NAME-captioned.mp4"

echo "[done] $WORK/out/$NAME-captioned.mp4"
echo "       end card: see README.md (button component or render-title.mjs)"
