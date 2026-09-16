# project-cli

Builds an **editable** OpenReel project from the command line. Captions, buttons and text
arrive in the editor as real objects you can select and change — not pixels burned into a
video file.

This is the counterpart to `tools/short-form-captions`, which burns captions in and gives
back a finished MP4. Use that one to ship a file; use this one when you want to keep editing.

## How it reaches the editor

Each command reads a project JSON, changes it, and writes it back, so a whole video is a
shell script. `serve` then hands it to the editor:

```
project-cli … → draft.json → serve → a URL that opens the project, media and all
```

`serve` copies the project and every file it references into the dev server's public
folder and prints a link:

```
http://localhost:5173/#/editor?open=<project>&media=<folder>
```

`open=` loads and validates the project; `media=` lets the editor fetch each file by name,
so it opens ready to play with no relinking. Both are handled in `App.tsx`.

Use `export` instead if you want the raw `{version, project}` JSON for something else — but
note the editor's own **Project JSON ▸ Import** dialog takes a *file*, not pasted text, and
`serve` is the easier route.

## Commands

```bash
cli() { node tools/project-cli/index.js "$@"; }   # a function, not a variable: zsh does not split those

cli new       draft.json --size 1080x1920 --fps 24 --name "s2 ad"
cli add-clip  draft.json --media storage/inbox/clip.mp4
cli subtitles draft.json --cues cues.json --preset hormozi --layer
cli component draft.json --component button --at -4 --props '{"label":"Create your Replika"}'
cli text      draft.json --text "Meet Replika." --at -4 --duration 4
cli serve     draft.json --open
cli export    draft.json --out project.json   # raw JSON, if you need it
```

`--at` accepts a negative number to count back from the end, so `--at -4` is "the last four
seconds" whatever the clip's length.

### subtitles

`--cues` takes either the grouped cues or the raw word list written by
`tools/short-form-captions` (`build_cues.py` / `transcribe.py`); a word list is grouped on
the fly into cues of at most 4 words and 20 characters.

`--preset` picks the look. Sizes are written for a 1080-wide frame and scale to whatever
the project is.

| Preset | Look |
|---|---|
| `hormozi` | ALL-CAPS Montserrat, thick stroke, yellow active word |
| `clean` | plain white Poppins, no animation |
| `bounce` | Inter, words spring in one at a time |
| `boxed` | Rubik, one word at a time on a dark bar |
| `highlight-box` | Poppins, active word on a pink block |

Every cue keeps its per-word timings, so the animation is real inside the editor and the
preview draws it with the same painter the exporter uses.

### component

With `--props`, renders the component through `packages/component-library` first (needs
Chrome; no Redis or render-service). With `--file`, uses a `.webm` you already rendered.
Either way it lands on a graphics track, and the clip keeps `componentId` and `props` in
its metadata so it can be re-rendered later.

## Captions: layer or overlay

Two ways to put captions in a project, and they are not interchangeable.

`--layer` is the one to reach for. It follows the editor's own caption feature: a track
named **Captions** (`role: "captions"`) holding one text clip per cue. Each caption is a
real clip you can drag, trim and restyle, and the editor lights up its native
"Select all captions" control.

Without `--layer` the cues go into `timeline.subtitles`, an overlay drawn above every
track. That path keeps per-word animation — karaoke, bounce, word-highlight — but never
appears on the timeline, and is edited from **Inspector ▸ AI tab** instead.

| | `--layer` | overlay (default) |
|---|---|---|
| Row on the timeline | yes, one clip per cue | no |
| Drag / trim one cue | yes | no |
| Word-by-word animation | no, static text | yes |
| Restyle every cue at once | no, per clip | yes |

There is no way to have both: the animation is drawn by the subtitle renderer, which only
reads `timeline.subtitles`.

## Track order is z-order

The timeline stores **the front-most track at index 0** (see `getVisibleTrackRenderOrder`
in core). Footage therefore has to sit last, or it paints over the captions and graphics
that are supposed to be above it — they vanish on export.

The CLI enforces this: any video track without a role is pushed to the back whenever a
track is added, giving

```
0  Captions    <- front
1  Graphics
2  Text
3  Video 1     <- back
```

## The whole recipe

From a raw clip to an editable project with captions, a button and a title.

```bash
cd Video-editor-MCP
cli() { node tools/project-cli/index.js "$@"; }
W=storage/caption-work
CLIP=storage/inbox/my-clip.mp4
NAME=my-clip

# 1. Word-level transcription, then group the words into short cues.
mkdir -p $W/audio $W/cues
ffmpeg -v error -y -i $CLIP -vn -ac 1 -ar 16000 -c:a pcm_s16le $W/audio/$NAME.wav
$W/venv/bin/python tools/short-form-captions/transcribe.py \
  $W/audio/$NAME.wav $W/cues/$NAME-words.json
python3 tools/short-form-captions/build_cues.py \
  $W/cues/$NAME-words.json $W/cues/$NAME-cues.json

# 2. Build the project. Order does not matter; footage always sorts to the back.
cli new       $W/$NAME.json --size 1080x1920 --fps 24 --name "$NAME"
cli add-clip  $W/$NAME.json --media $CLIP
cli subtitles $W/$NAME.json --cues $W/cues/$NAME-cues.json --preset bounce --layer
cli component $W/$NAME.json --component button --at -4 \
  --props '{"label":"Create your Replika","fillColor":"#ffffff","textColor":"#141422",
            "width":640,"height":132,"cornerRadius":66,"fontSize":46,"shadow":true,
            "positionY":0.87,"holdToEnd":true,"animation":"slideUp","easing":"soft",
            "slideSeconds":0.8,"durationInSeconds":4}'
cli text      $W/$NAME.json --text "Make it personal." --at -4 --duration 4 \
  --style '{"fontFamily":"Poppins","fontSize":88,"color":"#ff7a1a","fontWeight":800}' \
  --transform '{"position":{"x":0.5,"y":0.16}}'

# 3. Hand it to the editor. Start it first: cd apps/editor && pnpm dev
cli serve $W/$NAME.json --open
```

The result opens with four layers — Captions, Graphics, Text, Video — every asset loaded,
and nothing burned into the pixels.

The first transcription downloads the Whisper `large-v3` weights (~3 GB, cached in
`~/.cache/huggingface`) and creates the venv if `tools/short-form-captions/run.sh` has not
already done so.

## Operations behind it

The subtitle side is `set_subtitles`, `add_subtitle` and `remove_subtitle` in
`packages/project-kit`, alongside the existing clip, text and transition ops. They are
available over `POST /projects/:id/ops` too, for driving the render-service copy of a
project rather than a file.

## Tests

```bash
npm test --prefix tools/project-cli          # cue grouping and presets
npm test --prefix packages/project-kit       # the ops, including subtitles
```

The export was also checked against the editor's own `importFromJsonWithValidation`, which
accepts it with no errors.
