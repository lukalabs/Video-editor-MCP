# project-cli

Builds an **editable** OpenReel project from the command line. Captions, buttons and text
arrive in the editor as real objects you can select and change — not pixels burned into a
video file.

This is the counterpart to `tools/short-form-captions`, which burns captions in and gives
back a finished MP4. Use that one to ship a file; use this one when you want to keep editing.

## How it reaches the editor

Each command reads a project JSON, changes it, and writes it back, so a whole video is a
shell script. `export` wraps the result in the envelope the editor's importer expects:

```
project-cli … → draft.json → export → project.json → editor ▸ Project JSON ▸ Import
```

The editor keeps its projects in the browser, so there is no live sync — the JSON is the
handover. The format is `packages/project-kit`'s, which already matches the editor's
schema (1.2.0).

## Commands

```bash
cli() { node tools/project-cli/index.js "$@"; }   # a function, not a variable: zsh does not split those

cli new       draft.json --size 1080x1920 --fps 24 --name "s2 ad"
cli add-clip  draft.json --media storage/inbox/clip.mp4
cli subtitles draft.json --cues cues.json --preset hormozi
cli component draft.json --component button --at -4 --props '{"label":"Create your Replika"}'
cli text      draft.json --text "Meet Replika." --at -4 --duration 4
cli export    draft.json --out project.json
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

## After importing

The editor will say **"2 assets need replacement"**. That is expected and not an error: a
browser cannot open a file path, so the video itself has to be handed over once. Go to the
**Assets panel ▸ Relink from Folder** and pick the folder holding the media.

Relinking matches on file **name and size**, which is why `sourceFile` carries both — a
plain path would never match. Keep the media where it was when the project was built, or
copy it all into one folder first.

## Worked example

```bash
cli() { node tools/project-cli/index.js "$@"; }
W=storage/caption-work

cli new       $W/s1.json --size 1080x1920 --fps 24 --name "s1 alt"
cli add-clip  $W/s1.json --media storage/inbox/s1-alt-single-take.mp4
cli subtitles $W/s1.json --cues $W/cues/s1-alt-single-take-cues.json --preset clean
cli component $W/s1.json --component button --at -4 \
  --props '{"label":"Create your Replika","fillColor":"#ffffff","textColor":"#141422",
            "width":640,"height":132,"cornerRadius":66,"fontSize":46,"shadow":true,
            "positionY":0.87,"holdToEnd":true,"animation":"slideUp","easing":"soft",
            "slideSeconds":0.8,"durationInSeconds":4}'
cli export    $W/s1.json --out $W/s1.project.json
```

Produces a 28.5s project: the clip on a video track, 32 word-timed captions, and the button
on a graphics track starting at 24.47s.

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
