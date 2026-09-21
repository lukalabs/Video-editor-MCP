# Troubleshooting

Symptoms seen in practice, what actually caused them, and the fix. Full write-ups with the
measurements live in [NOTES.md](../NOTES.md); this file is the short lookup.

---

## A rendered component stutters, or looks like it plays at a lower framerate than the footage

**Symptom.** Composite a component over 24fps footage and the component looks like it runs at
~16fps while the footage is fine. Smooth motion on the component alone; stutter only once it is
over the video.

**Cause.** WebM stores timestamps in whole milliseconds. 24fps frames land on 41.666…ms, so the
file carries `0, 42, 83, 125, 167` where the timeline asks for `0, 41.667, 83.333, 125, 166.667`.
At 41.667 the newest component frame is still the one from 0 — 42 has not arrived yet — so the
compositor reuses it. Two frames move, one holds, repeating. That is 2/3 of 24 = 16fps.

**Fix.** Rebuild the overlay's timestamps from its frame index instead of trusting the stored
ones:

```bash
ffmpeg -i footage.mp4 -c:v libvpx-vp9 -i component.webm \
  -filter_complex "[1:v]setpts=N/24/TB[b];[0:v][b]overlay=0:0:shortest=1" \
  -r 24 -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac out.mp4
```

Match the `24` in `setpts=N/24/TB` to the timeline's framerate.

**Scope.** Not an ffmpeg quirk. Any 24fps consumer that honours the embedded timestamps hits the
same rounding — the editor's own import path included. That path is untested; verify before
building a timeline that depends on it.

**How to confirm it is this and not the animation.** Measure the *composite*, not the component
file. Frame-to-frame difference over the moving region shows every third value collapsing to the
static-footage noise floor:

```
108089, 9951, 267081, 174705, 4347, 358810, 273206, 4753, 421006, 211143, 5258, ...
         ^^^^                 ^^^^                  ^^^^
```

The component's own file measures clean, because the defect does not exist until the two layers
are combined. Three rounds of animation fixes went into the wrong layer for exactly this reason.

**Framerates that do not have this problem:** 25fps (40ms) and 50fps (20ms) divide evenly into
milliseconds. 24, 30 and 60 do not.

---

## A render fails with `unknown format:` and no other detail

**Symptom.** The browser-side render throws `unknown format: ` (note the empty value) and the job
fails with nothing pointing at a cause.

**Cause.** A colour property was passed an explicit `null`. It reaches Motion Canvas's colour
parser as an empty string. Seen with `shadowColor={null}` when a `shadow` parameter was false.

**Fix.** Omit the property rather than nulling it — spread it in conditionally:

```tsx
const shadowProps = shadow
  ? { shadowColor: "rgba(0, 0, 0, 0.35)", shadowBlur: 32, shadowOffset: [0, 12] }
  : {};

<Rect {...shadowProps} />
```

`stroke={null}` and `fill={null}` are fine — those are legitimately nullable. It is the shadow
colour specifically that breaks.

---

## Fast graphic motion steps visibly at 24fps

**Symptom.** A graphic moving quickly looks stepped, even with correct timestamps and smooth
easing.

**Cause.** At 24fps there are only ~24 samples per second. A long travel means large gaps between
them, and no easing curve can fill a gap that was never sampled. Real footage hides this behind
motion blur; a rendered graphic has none.

**Fix.** `scripts/render.mjs --motion-blur N` renders at `fps * N` and averages each group down to
one output frame, using a 180-degree shutter (half the interval, like a film camera). `--motion-blur 8`
is a good default for fast motion.

```bash
node scripts/render.mjs --component button --fps 24 --motion-blur 8 ...
```

**Costs.** N times the frames through headless Chrome. 8x on a 3-second 1080x1920 render is ~4
minutes and enough memory pressure to get processes OOM-killed on a 16GB machine with other work
running. Opt-in for a reason — static or slow elements do not need it.

**Do not use 4x.** Too few samples leaves visible ghosting — discrete copies of the element rather
than a smear. 8 is the floor for a fast move.

---

## Uneven motion that measures as smooth

**Symptom.** Every frame moves, no duplicates, monotonic easing curve — and it still reads as
stuttering.

**Cause.** At low framerates the *change* in step size matters more than the step size. A
front-loaded ease like `easeOutCubic` produces `55, 49, 45, 39, 35...` px per frame; the shifting
rhythm reads as dropped frames even though none are dropped.

**Fix.** Either slow the move so the steps shrink, or use an easing with a near-constant middle
(`easeInOutSine`, exposed as `even` on the button component). Step-to-step change of 0–4px reads
smooth; 6–10px does not.

Note that this is a *contributing* factor, not usually the whole problem. If the motion looks
badly wrong, check the timestamp issue at the top of this file first — that one is much larger.

---

## Services die seconds after starting

**Symptom.** The API, worker and editor dev server all get killed shortly after launch, repeatedly.

**Cause.** Out of memory. macOS reports a misleading "free percentage" that counts inactive pages;
check the real numbers:

```bash
vm_stat | awk '/Pages free/{printf "free: %.0f MB\n", $3*4096/1048576}'
sysctl -n vm.swapusage
```

Under ~100MB free with swap near capacity, nothing will stay running. Heavy motion-blur renders
push a 16GB machine there on their own.

**Fix.** Free memory before rendering. Docker Desktop's VM, crash-looping containers from other
projects, and browsers are the usual holders. Note that `docker stats` shows the VM's memory
*limit* as the denominator — that is not what Docker is consuming.

**Not needed for component renders:** `scripts/render.mjs` spawns its own Vite and Chrome and
talks to nothing else. Redis, the render API, the worker and the editor can all be down and
component rendering still works. Only the queue and export paths need them.
