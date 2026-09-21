# Short-form captions and end cards

Burns TikTok/Reels-style captions onto vertical clips, then adds an end card in
the last four seconds. Everything runs locally: no cloud APIs, no keys.

Built for the four Replika clips in `storage/inbox/`; the presets and the caption
spec below came out of that job.

## Pipeline

```
clip.mp4
  -> ffmpeg            16 kHz mono wav
  -> transcribe.py     faster-whisper, per-word start/end
  -> build_cues.py     words grouped into 3-4 word cues, max 20 chars
  -> render-captions.mjs
       headless Chrome draws each frame with the editor's own paintSubtitle
       (packages/core/src/text/caption-painter.ts, bundled by esbuild)
  -> ffmpeg            PNG band composited back over the clip
  -> end card          button component, or render-title.mjs
```

Captions are drawn by the editor's own painter rather than a copy of it, so a
burned-in result matches what the editor preview shows.

## Prerequisites

| Need | Why | Note |
|---|---|---|
| Python 3.13 | transcription venv | 3.14 has no `ctranslate2` wheel |
| Node 18+ | frame rendering | uses `puppeteer-core` from `apps/render-service` |
| Chrome | headless canvas | override with `CHROME_PATH` |
| ffmpeg | audio + compositing | **libass not required**, see Gotchas |
| pnpm install in `apps/editor` | esbuild + the painter source | |

Fonts are read from `~/Library/Fonts`. The presets expect Montserrat, Poppins,
Inter, Rubik and Pangea; swap the `font` field for whatever is installed.

## Usage

```bash
./run.sh ../../storage/inbox/s2-let-me-guess.mp4 s2-let-me-guess
```

First run creates the venv and downloads the Whisper `large-v3` weights (~3 GB,
cached in `~/.cache/huggingface`). Output lands in `storage/caption-work/out/`.

`presets.json` is keyed by clip name. For a new clip, add an entry or pass the
key of a preset whose look you want; sizes scale from a 1080-wide reference.

### End cards

Two kinds, both composited over the last four seconds.

**Button** — the existing `button` component already covers this, so there is no
code here for it:

```bash
cd ../../packages/component-library
node scripts/render.mjs --component button --fps 24 --width 1080 --height 1920 \
  --props '{"label":"Create your Replika","fillColor":"#ffffff","textColor":"#141422",
            "width":640,"height":132,"cornerRadius":66,"fontSize":46,"shadow":true,
            "positionY":0.87,"holdToEnd":true,"animation":"slideUp","easing":"soft",
            "slideSeconds":0.8,"durationInSeconds":4}' \
  --out /tmp/btn.webm
```

`positionY` 0.87 puts it below the captions at 0.74. The output is a transparent
VP9 WebM — **it must be decoded with `-c:v libvpx-vp9`** or the alpha is dropped
and the button arrives on a black card.

**Title** — `render-title.mjs`, for two-line text that slides in and holds:

```bash
PUPPETEER_CORE_PATH="file://$PWD/../../apps/render-service/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js" \
node render-title.mjs /tmp/title '{"width":1080,"height":1920,"fps":24,"duration":4,
  "fontSize":100,"anchorY":0.135,"travel":300,"slideSeconds":1.15,
  "lines":[{"text":"Make it personal.","color":"#ffffff"},
           {"text":"Meet Replika.","color":"#ff7a1a"}],
  "chromePath":"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "fontPath":"'"$HOME"'/Library/Fonts/FwTRIAL-Pangea-Bold.otf"}'
```

Positive `travel` enters from above. Easing is ease-out quintic; the fade
completes at 60% of the slide so the landing reads as motion, not as a fade.

**Darkening** — `make_gradients.py` writes the edge gradients that sit under an
end card. Faded in over 0.8-1.0s alongside the card:

```
[1]format=rgba,fade=in:st=0:d=1.0:alpha=1[g];[0][g]overlay=0:0:enable='gte(t,START)'
```

Peak 15% behind a button, 25% behind a title. The falloff is curved (`^1.6`)
because a straight ramp leaves a visible band edge.

## The caption spec

Researched for this job; sources at the bottom.

| Parameter | Value | Why |
|---|---|---|
| Words per cue | 3-4, max 20 characters | karaoke style runs far shorter than the 37-42 broadcast norm |
| Max lines | 2 | more clutters the frame |
| Font size | 72px at 1080 wide | 48px is the floor at 1080x1920; ~70 is the sweet spot |
| Font | heavy sans (Black / ExtraBold) | stays solid over moving footage |
| Vertical anchor | 0.74 | clear of the buttons and description covering the lower fifth |
| Colours | white, coloured active word, black outline | readable on mute, on any background |
| Timing | real per-word timestamps | evenly divided timing drifts and viewers feel it |

## Presets

| Key | Style | Look |
|---|---|---|
| `s2-let-me-guess` | Hormozi | ALL-CAPS Montserrat Black, thick stroke, yellow active word |
| `s1-alt-single-take` | Clean minimal | plain white Poppins Black, no pop, no colour |
| `s1-almost-gave-up` | TikTok Bounce | Inter Black, words spring in one by one |
| `s1-v3-selfie-daylight` | Boxed | Rubik Black, one word at a time on a dark bar |

A fifth, **Highlight box** (active word on a solid colour block), is supported by
the painter via `highlightBackgroundColor` and `highlightRadius`.

## Gotchas

These each cost a rebuild; they are the reason this folder exists.

**whisper.cpp word timings drift.** Its `-ml 1 -sow` timings ran 2-3 seconds
behind by the 20s mark and placed words past the end of the audio. Its `--dtw`
alignment reported `t_dtw: -1` for every token, so it was doing nothing. Hence
`faster-whisper`, which aligns properly. Do not swap it back without checking
sync at several points against the audio, not just at the start.

**Homebrew ffmpeg has no libass.** The formula no longer depends on it, so
`ass` and `subtitles` filters do not exist and the usual `.ass` burn-in route is
closed. That is why captions are rendered as PNG frames instead.

**Canvas trims trailing spaces when measuring.** `measureText("word ")` returns
the width of `"word"`, so advancing by that width runs words together. The
painter measures a space by difference (`"i i"` minus `"ii"`).

**A scaled word needs a wider slot.** The active word scales to 1.15; laying out
at unscaled width makes it overlap its neighbours. Slots use
`max(1, scale)` so a word scaling *up* gets room while one animating up from
small (bounce) keeps its settled slot and the line does not jitter.

**Captions do not wrap.** One line, no wrapping, so `render-captions.mjs`
measures every cue up front and shrinks the font until the widest fits 90% of
the frame. ALL-CAPS presets overflow 1080px without this.

## Sources

- [Caption font size for Reels](https://www.itnavideo.com/blog/caption-font-size-guide-reels)
- [Subtitle styling and burn-in](https://syllaby.io/blog/subtitle-styling-burn-in-caption-timing-guide/)
- [Captioning for 9x16 video](https://www.closedcaptioncreator.com/blog/articles/captioning-for-9x16-video.html)
- [Word-by-word animated captions](https://voicecreator.pro/blog/word-by-word-animated-captions)
- [Hormozi caption style](https://ascynd.io/en/blog/hormozi-captions)
- [TikTok caption styles 2026](https://blitzcutai.com/blog/best-caption-style-tiktok)
