# The `button` component

One component covering the whole button set. Style and size are parameters, so a different button
is a different set of values — not a new component. Renders on transparency, so it composites over
footage directly.

Rendered from the CLI:

```bash
cd packages/component-library
node scripts/render.mjs --component button --width 1080 --height 1920 --fps 24 --motion-blur 8 \
  --props '{"label":"Try Replika","animation":"slideUp","positionY":0.82,"holdToEnd":true}' \
  --out ../../storage/rendered/cta.webm
```

Or through the render service / MCP with `componentId: "button"`, passing `width` and `height` for
anything that is not 16:9.

**Compositing these files at 24fps needs a timestamp fix** — see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md), first entry. Without it the button appears to run at
16fps.

## Parameters

| Key | Type | Default | Notes |
|---|---|---|---|
| `label` | text | `Get started` | |
| `fillColor` | colour | `#34d399` | The stroke colour when `outlined` |
| `textColor` | colour | `#0b1220` | Ignored when `outlined` — the label takes `fillColor` |
| `width` | number | 420 | 120–1200 |
| `height` | number | 120 | 48–400 |
| `cornerRadius` | number | 60 | 0 is square; half the height is a pill |
| `fontSize` | number | 42 | 12–120 |
| `outlined` | boolean | false | Outline only, transparent middle — footage shows through |
| `borderWidth` | number | 4 | 1–16, only used when `outlined` |
| `shadow` | boolean | true | |
| `positionY` | number | 0.5 | 0 is the top edge, 1 the bottom. 0.82 sits in the lower third |
| `holdToEnd` | boolean | false | On: stays to the last frame. Off: fades out |
| `slideSeconds` | number | 0.8 | 0.3–3. `slideUp` only |
| `animation` | text | `popIn` | See below |
| `easing` | text | `soft` | See below |
| `durationInSeconds` | number | 3 | 1.5–12 |

`animation` and `easing` are free text because the editor panel's param types are text, number,
colour, boolean and media — there is no dropdown control. An unrecognised name falls back to the
default rather than failing the render.

## Animations

| Name | What it does | Good for |
|---|---|---|
| `popIn` | Scales up from 0.6 with a fade | Default. Reads as an appearance, not an arrival |
| `slideUp` | Starts fully outside the bottom edge and rides in, opaque the whole way | End cards, CTAs. The only one that travels a real distance |
| `lift` | Rises 40px with a fade | A nudge. Subtle emphasis, not an entrance |
| `fadeIn` | Fade with a slight scale from 0.94 | The quietest option |
| `press` | Enters on a fade, then depresses to 0.94 and releases once, mid-clip | Demonstrating a tap |
| `pulse` | Enters on a fade, then breathes 1.0 → 1.06 on a 0.5s beat for as long as the hold allows | Drawing the eye to a CTA that sits on screen a while |

`slideUp` uses `slideSeconds` for its travel time. The others use a fixed 0.45s entrance.

## Easings

All four are available on every animation. Reviewed side by side over real footage at 24fps:

| Name | Curve | Peak speed* | Character |
|---|---|---|---|
| `soft` | `easeOutCubic` | 59 px/frame | Arrives fast, settles gently. **The chosen default** |
| `snappy` | `easeOutQuint` | 95 px/frame | Hits hard and stops almost dead. The most urgent |
| `springy` | `easeOutBack` | 98 px/frame | Overshoots ~50px past the mark, then settles back. The bounce |
| `even` | `easeInOutSine` | 41 px/frame | Constant speed, gentle at both ends. Calmest, least UI-like |

\* Measured on a 375px `slideUp` over 0.8s at 1080x1920 / 24fps. Peak speed scales with travel
distance and inversely with `slideSeconds`.

`springy` is the only one that overshoots its resting position — it passes the target and returns.
That is the classic tappable-app-button feel, and the right pick when you want the button to feel
physical.

`even` exists because a near-constant rate survives low framerates better than a front-loaded
curve does. Reach for it if a fast move still reads as uneven after the timestamp fix — see the
"Uneven motion that measures as smooth" entry in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Worked examples

**Vertical end card, CTA slides up and stays** — the reviewed default:

```json
{
  "label": "Try Replika", "fillColor": "#7c5cff", "textColor": "#ffffff",
  "width": 760, "height": 150, "cornerRadius": 75, "fontSize": 52,
  "positionY": 0.82, "holdToEnd": true,
  "animation": "slideUp", "easing": "soft", "slideSeconds": 0.8,
  "durationInSeconds": 2.5
}
```

Render at `--width 1080 --height 1920 --fps 24 --motion-blur 8`.

**Outlined secondary button, square corners:**

```json
{
  "label": "Learn more", "fillColor": "#ffffff", "outlined": true, "borderWidth": 5,
  "width": 560, "height": 140, "cornerRadius": 16, "fontSize": 52, "shadow": false,
  "animation": "lift", "easing": "springy", "durationInSeconds": 3
}
```

## Files

```
src/scenes/button.tsx            the component
src/projects/button.ts           default props
src/projects/button.meta         Motion Canvas project meta
components/button/meta.json      the panel's parameter schema
```

Registering a new component means adding it in three more places: the `project` array in
`vite.config.ts`, the imports and `PROJECTS` map in `src/render-harness.ts`, and its own
`components/<id>/meta.json`. Missing the harness gives
`Unknown project "<id>". Known: ...` at render time.
