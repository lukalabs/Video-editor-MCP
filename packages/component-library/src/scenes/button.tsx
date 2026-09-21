import { Rect, Txt, makeScene2D } from "@motion-canvas/2d";
import {
  all,
  createRef,
  easeInCubic,
  easeInOutSine,
  easeOutBack,
  easeOutCubic,
  easeOutQuint,
  useScene,
  waitFor,
} from "@motion-canvas/core";

const IN_DURATION = 0.45;
const OUT_DURATION = 0.35;
const MIN_HOLD = 0.3;

/**
 * `slideUp` starts fully outside the bottom of the frame and rides all the way in, so the button
 * reads as arriving from off-screen rather than fading in near its resting place. That is a long
 * travel for 24fps, so render it at a multiple of the target rate and blend the extra frames down
 * (scripts/render.mjs --motion-blur) — without that the first frames step by 40px or more.
 */
const SLIDE_MARGIN = 80;

/**
 * Compositing note, not an animation one: WebM timestamps are whole milliseconds and 24fps frames
 * fall on 41.666...ms, so a compositor reading this file's own timestamps runs out of fresh button
 * frames and repeats one roughly every third frame — which looks exactly like a stuttering ease.
 * Rebuild the timestamps from the frame index when overlaying: [1:v]setpts=N/24/TB.
 */

const FONT_FAMILY = "Inter, Segoe UI, Helvetica, Arial, sans-serif";

const EASINGS = {
  soft: easeOutCubic,
  snappy: easeOutQuint,
  springy: easeOutBack,
  even: easeInOutSine,
} as const;

const ANIMATIONS = ["fadeIn", "popIn", "lift", "slideUp", "press", "pulse"] as const;

type EasingName = keyof typeof EASINGS;

/**
 * A single UI button, rendered on transparency so it can sit over footage.
 *
 * Every visual choice — size, colour, radius, filled vs outlined, where it sits in the frame —
 * is a parameter, so one component covers the whole button set rather than one component per
 * style. `animation` and `easing` are free-text params because the editor panel has no dropdown
 * control; both fall back to their default when given a name that isn't in the list.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const label = String(variables.get("label", "Get started")());
  const fillColor = String(variables.get("fillColor", "#34d399")());
  const textColor = String(variables.get("textColor", "#0b1220")());
  const width = Number(variables.get("width", 420)());
  const height = Number(variables.get("height", 120)());
  const cornerRadius = Number(variables.get("cornerRadius", 60)());
  const fontSize = Number(variables.get("fontSize", 42)());
  const outlined = Boolean(variables.get("outlined", false)());
  const borderWidth = Number(variables.get("borderWidth", 4)());
  const shadow = Boolean(variables.get("shadow", true)());
  const positionY = Number(variables.get("positionY", 0.5)());
  const holdToEnd = Boolean(variables.get("holdToEnd", false)());
  const slideSeconds = Number(variables.get("slideSeconds", 1.2)());
  const totalDuration = Number(variables.get("durationInSeconds", 3)());

  const animation = pick(ANIMATIONS, variables.get("animation", "popIn")(), "popIn");
  const ease = EASINGS[pick(Object.keys(EASINGS) as EasingName[], variables.get("easing", "soft")(), "soft")];

  // positionY is normalised 0 (top edge) to 1 (bottom edge), matching how the editor's own text
  // clips are positioned; the scene works in centre-origin pixels, hence the shift.
  const frameHeight = view.size().y;
  const restY = (positionY - 0.5) * frameHeight;

  const button = createRef<Rect>();

  // Spread rather than pass `shadowColor={null}`: an explicitly null shadow colour reaches the
  // colour parser as an empty string and fails the render with "unknown format".
  const shadowProps = shadow
    ? { shadowColor: "rgba(0, 0, 0, 0.35)", shadowBlur: 32, shadowOffset: [0, 12] }
    : {};

  // An outlined button draws its colour as a stroke and leaves the middle transparent, so the
  // footage underneath shows through; a filled one strokes nothing.
  view.add(
    <Rect
      ref={button}
      width={width}
      height={height}
      radius={cornerRadius}
      fill={outlined ? null : fillColor}
      stroke={outlined ? fillColor : null}
      lineWidth={outlined ? borderWidth : 0}
      {...shadowProps}
      y={restY}
      opacity={0}
      layout={false}
    >
      <Txt
        text={label}
        fill={outlined ? fillColor : textColor}
        fontFamily={FONT_FAMILY}
        fontSize={fontSize}
        fontWeight={600}
        letterSpacing={0.5}
      />
    </Rect>,
  );

  // Entrance. `press` and `pulse` describe what the button does once it is on screen, so they
  // enter on a plain fade and spend their time in the hold below.
  switch (animation) {
    case "popIn":
      button().scale(0.6);
      yield* all(button().opacity(1, IN_DURATION, ease), button().scale(1, IN_DURATION, ease));
      break;
    case "lift":
      button().y(restY + 40);
      yield* all(button().opacity(1, IN_DURATION, ease), button().y(restY, IN_DURATION, ease));
      break;
    case "slideUp":
      // Clear the bottom edge by the button's own half-height plus room for its shadow.
      button().y(frameHeight / 2 + height / 2 + SLIDE_MARGIN);
      // Opaque from the first frame: it is already outside the frame, so there is nothing to
      // fade in — fading here would read as an appear rather than an arrival.
      button().opacity(1);
      yield* button().y(restY, slideSeconds, ease);
      break;
    case "fadeIn":
      button().scale(0.94);
      yield* all(button().opacity(1, IN_DURATION, ease), button().scale(1, IN_DURATION, ease));
      break;
    default:
      yield* button().opacity(1, IN_DURATION * 0.6, ease);
      break;
  }

  // A button that holds to the end owns the whole remaining clip; one that exits has to leave
  // room for the fade.
  const entrance = animation === "slideUp" ? slideSeconds : IN_DURATION;
  const hold = Math.max(
    MIN_HOLD,
    totalDuration - entrance - (holdToEnd ? 0 : OUT_DURATION),
  );

  switch (animation) {
    case "press":
      yield* pressOnce(button, ease, hold);
      break;
    case "pulse":
      yield* pulseFor(button, ease, hold);
      break;
    default:
      yield* waitFor(hold);
      break;
  }

  if (holdToEnd) return;

  yield* all(
    button().opacity(0, OUT_DURATION, easeInCubic),
    button().scale(0.96, OUT_DURATION, easeInCubic),
  );
});

/** Push the button down and let it come back, centred in the time available. */
function* pressOnce(button: ReturnType<typeof createRef<Rect>>, ease: typeof easeOutCubic, hold: number) {
  const down = Math.min(0.12, hold * 0.2);
  const up = Math.min(0.28, hold * 0.35);
  yield* waitFor((hold - down - up) / 2);
  yield* button().scale(0.94, down, easeOutQuint);
  yield* button().scale(1, up, ease);
  yield* waitFor((hold - down - up) / 2);
}

/** Breathe in and out on a fixed beat for as many whole cycles as the hold allows. */
function* pulseFor(button: ReturnType<typeof createRef<Rect>>, ease: typeof easeOutCubic, hold: number) {
  const beat = 0.5;
  const cycles = Math.max(1, Math.floor(hold / (beat * 2)));
  for (let i = 0; i < cycles; i += 1) {
    yield* button().scale(1.06, beat, ease);
    yield* button().scale(1, beat, ease);
  }
  yield* waitFor(Math.max(0, hold - cycles * beat * 2));
}

/** Free-text params are user input: accept a known name, otherwise fall back to the default. */
function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  const name = String(value);
  return (allowed as readonly string[]).includes(name) ? (name as T) : fallback;
}
