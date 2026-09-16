# orchestrate

One sentence in, one editable project out — across all three repos.

```bash
orchestrate make "a redhead woman in a sunny dorm room says [script], holding her
                  phone with the Replika Memory screen showing that she broke up
                  with her boyfriend. A 'Try Replika now' button in the last 5
                  seconds, TikTok subtitles, and the branded packshot."
```

That runs four things in order and hands you a project in the editor:

| Step | What it does | Where |
|---|---|---|
| `ui-snap` | renders the Replika screen as a PNG | `POST /api/shot` on :3000 |
| `ugc-farm` | films an AI person saying the script, holding that screen | the API on :8765 |
| `captions` | word-level transcription of what she actually said | `tools/short-form-captions` |
| `button` + `packshot` | the CTA and the end card | `tools/project-cli` |

Captions, button and packshot arrive as real objects you can select and change.
Nothing is burned into the pixels — same promise as `project-cli`, which this
drives rather than replaces.

## The short way

```bash
orchestrate start
```

Brings the three servers up if they are not already, then asks:

```
make ▸ a redhead woman in a sunny dorm room says […]
```

It plans, takes the screenshot, writes the video prompt, shows you what a render
would cost — and then asks once before spending. Answer `n` and it stays a dry
run you can pay for later. Then it asks again, until you type `quit`.

At the prompt you can also type `720p` / `1080p` / `480p` to change resolution,
`clip <path>` to edit a clip you already have instead of rendering one (free),
`clip` on its own to go back to rendering, `again` to repeat, or `help`.

Each finished project opens in the editor on its own — the `start` session always
passes `--open`. Use `orchestrate make … --no-serve` when you want the files
without a browser window.

`orchestrate stop` shuts the servers down. They keep running after `quit`, which
is usually what you want.

## Every command

```bash
orchestrate start                       # the above
orchestrate stop                        # servers down
orchestrate make "<prompt>" [flags]     # one run, scriptable
orchestrate resume <run-id> [flags]     # continue one, without paying twice
orchestrate plan "<prompt>"             # just the planning. Free, no side effects
orchestrate doctor                      # is everything this needs running?
```

## Flags

| Flag | Default | What it changes |
|---|---|---|
| `--dry-run` | | everything except the paid render (see below) |
| `--spend` | | **required** before anything is rendered |
| `--media <file>` | | skip ugc-farm and edit a clip you already have |
| `--only <step,…>` | all | run part of the chain |
| `--captions overlay\|layer\|none` | `overlay` | see *Captions*, below |
| `--preset <name>` | from the prompt | `hormozi`, `clean`, `bounce`, `boxed`, `highlight-box` |
| `--resolution 480p\|720p\|1080p` | `1080p` | 1080p comes back as 10-bit HEVC — see below |
| `--size` / `--fps` | `1080x1920` / `30` | the canvas |
| `--button-lead <s>` | from the prompt | how long the CTA is on screen |
| `--flatten-color <#hex>` | `#16181D` | what the screenshot's transparency is painted onto |
| `--no-serve` / `--open` | serve | hand the finished project to the editor, or don't |
| `--keep <n>` | `8` | how many served copies to leave in the editor's public folder |

## The servers

`start` handles them. `doctor` deliberately does not — when something is wrong,
a server you started yourself in a terminal you can read beats a tidy one-liner:

```bash
orchestrate doctor
```

It checks the three servers, ffmpeg, Chrome, the whisper virtualenv and the
Gemini key, and prints the exact command for anything missing. To run them by
hand:

```bash
cd ~/scripts-code/ui-animation/ui-snap       && bun dev                        # :3000
cd ~/scripts-code/ugc-farm                   && python3 ugc.py serve           # :8765
cd apps/editor && pnpm --filter @openreel/web dev                              # :5173
```

Started by `start` instead, they run detached and log to
`storage/orchestrate/logs/`, so one that dies leaves an explanation behind.

## Telling it what to do

Two ways, and they work together.

**Just describe it.** Gemini reads the sentence and fills in the script, the scene,
the memory text, the button label and the caption style. `orchestrate plan "…"`
shows you what it understood, for free, without doing anything.

**Or tag it.** `@ui-snap`, `@ugc-farm`, `@captions`, `@button`, `@packshot`
anywhere in the prompt pin which steps run, whatever the prose says. The planner
still fills in every parameter, so a tagged run and a resumed run behave the same.

```bash
orchestrate make "@captions @button subtitles and a CTA on this" --media clip.mp4
```

### The rule that protects the render

A prompt mixes two different kinds of instruction. "A redhead woman in a sunny
dorm room" is for the camera. "A button in the last 5 seconds" is for the editor.

If the second kind reaches ugc-farm, the video model draws a fake button and burns
in fake subtitles, underneath the real ones — and you have paid for it. So the
planner is told, in as many words, that the scene description contains only what a
camera in the room would record. `orchestrate plan` prints that field; it is worth
reading once.

The other half of the same rule: the script field is spoken words only. ugc-farm
counts the words in it to decide how many parts the video splits into, and every
part is a separate paid render, so a stage direction in there costs money.

## About 1080p

The default. Seedance returns 1080p as **10-bit HEVC** (`hvc1`, `yuv420p10le`)
rather than H.264, which is worth knowing in two places:

- The browser editor decodes it here — checked against this machine's Chrome with
  `VideoDecoder.isConfigSupported` — and exports fine to H.264. If a clip ever
  loads as audio-only or refuses to scrub, that is the first thing to suspect.
- It is roughly 2x the file of 720p for the same seconds, and the render bills by
  output seconds at about 48,700 tokens per second at 1080p against 21,600 at
  720p, so it is also more than twice the cost.

`--resolution 720p` while you are iterating on framing, wording or the screen in
the shot; the default when the take is the one you are keeping.

## Money

Only one thing in this chain costs money: the ugc-farm render. Everything else —
the screenshot, the transcription, the button, the timeline — runs on this machine.

Three things stand between a typo and a bill:

1. **`--spend` is required.** Without it the run does everything else and stops.
2. **`--dry-run`** goes further: it creates the ugc-farm project, uploads the
   screen, writes the prompt, and prints the exact payload a render would send,
   then stops. Gemini gets called a handful of times — cents. Nothing else.
3. **The daily cap.** Set `RENDER_DAILY_LIMIT` in `ugc-farm/.env` and the service
   refuses past it. Unset, there is no limit and the cap check is decoration.

A dry run's project is real, so the paid run repeats none of it:

```bash
orchestrate make "…" --dry-run
orchestrate resume 20260917-005121-5939a5 --spend
```

## When something breaks

Every run lives in `storage/orchestrate/<run-id>/` — the screenshot, the clips,
the words, the button, the draft, and `run.json` saying how far it got. `resume`
reads the ugc-farm project first and treats **the server** as the truth about what
has been paid for, so a part it already lists is downloaded, never re-rendered.

| What happened | Recoverable for free? |
|---|---|
| the render landed, this crashed afterwards | yes — resume fetches it |
| ugc-farm restarted while this was waiting | yes, if the render finished first |
| ugc-farm died mid-render | **no.** Already charged. Resume stops and prints the task id rather than quietly paying again |
| the render failed at the model | **no.** Charged before it started. `--resubmit-part N` pays again, and says so |

## Captions: which one

`--captions overlay` (the default) gives real word-by-word animation — the yellow
active word, the bounce. It lives above every track and is edited from
**Inspector ▸ AI tab**, not the timeline.

`--captions layer` gives a **Captions** track with one clip per cue, each
draggable and trimmable — but the text sits still.

You cannot have both: the animation is drawn by a renderer that only reads the
overlay. Pick per video.

## Two things worth knowing

**The button ends exactly where the packshot begins.** They sit on different tracks,
and the editor's overlap check is per-track — so nothing would warn you if they
collided. The arithmetic is what keeps them apart, and the run prints it:

```
  clip 1    [      0,  28.468]
  button    [ 23.435,  28.468]
  packshot  [ 28.468,  32.535]
  gap       0s between the button and the end card
```

**The first captions run downloads about 3 GB** of Whisper weights and looks
exactly like a hang. After that, expect roughly two to four times the clip's
length, on CPU.

## Tests

```bash
npm test --prefix tools/orchestrate
```

The timeline arithmetic, the tag routing and the value-pinning all run with no
network and no services.
