/**
 * Thread pacing and the house ease-out, ported from ui-animation's
 * `ui-snap/src/lib/timeline.ts`, plus the multi-message text encoding.
 *
 * Every constant below is verified against that file (2026-09-10). One correction to the
 * extraction report that fed this work: HOLD_OUT was missing from it, and the total duration
 * is `cursor + HOLD_OUT`, so a thread built without it finishes 1.6s early.
 */

/** A beat of empty screen before anything arrives. */
export const LEAD_IN = 0.35;
/** Beat after one of your lines before her typing dots appear. */
export const SHE_REACTS = 0.45;
/** Still frames at the end, so the last line can be read. */
export const HOLD_OUT = 1.6;
/** Seconds before one of your messages appears — you, thinking and typing. */
export const USER_DELAY = 0.5;

/**
 * How long a bubble takes to land: 240ms.
 *
 * Deliberately NOT scaled by `durationInSeconds`, which breaks this library's usual
 * everything-scales-proportionally convention. The source is explicit that UI motion stays
 * under 300ms and that "a dropdown that takes 400ms feels broken" — the pacing of a
 * conversation is meant to come from the pauses, not from slowing the bubbles down. A 2x
 * stretch would put the entrance at 480ms and lose the thing being ported.
 */
export const ENTER = 0.24;

/**
 * How long a bubble takes to leave: the entrance, played backwards.
 *
 * Aliased rather than given its own number, because the exit is not a second animation with
 * a similar feel — it is the same one time-reversed (see exitTransform in balloon-bubble.tsx),
 * and two constants that happen to be equal could drift apart.
 *
 * The source has no exit at all; this is new design, not a port. Everything about HOW it
 * moves is still the source's, since it is the entrance run in reverse.
 */
export const EXIT = ENTER;

/**
 * Gap between one bubble starting to leave and the next, in a thread.
 *
 * 0.12s is the stagger orbit-headline-Rep already uses for its words (3.5 frames in that
 * source). At half the exit duration, consecutive bubbles overlap by 50%, which reads as one
 * wave leaving rather than a queue being served. Fixed rather than paced, for the same
 * reason ENTER is fixed: it is motion character, not conversational pacing.
 */
export const EXIT_STAGGER = 0.12;

/**
 * How long she "types" before a line lands: longer messages take longer, clamped at both
 * ends so a one-word reply still reads as a pause and an essay does not stall the clip.
 * Computed per message from its own word count — never a manual parameter.
 */
export function typingFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(2.4, Math.max(0.7, 0.55 + words * 0.13));
}

export type Sender = "sent" | "received";

export interface ChatMessage {
  from: Sender;
  /** Body with the action asterisks already stripped. */
  text: string;
  /** Whole-message roleplay action — renders italic. */
  action: boolean;
}

export interface TimedMessage {
  message: ChatMessage;
  /** When the bubble starts landing. */
  appearAt: number;
  /** Received lines only: when the typing dots appear. They give way at `appearAt`. */
  typingFrom: number | null;
  /** When this bubble starts leaving. Oldest first, staggered by EXIT_STAGGER. */
  exitAt: number;
}

export interface Timeline {
  items: TimedMessage[];
  /** When the first (oldest) bubble starts leaving. */
  exitFrom: number;
  /** Total length: the hold, plus the whole staggered exit. */
  duration: number;
}

/**
 * Replika's roleplay convention, from the source: physical actions in *single asterisks*,
 * dialogue plain, never mixed. "Never mixed" makes it a whole-message question rather than
 * an inline one, so an action is a message that is entirely wrapped and renders italic with
 * the asterisks removed. The inner match rejects asterisks on purpose — a greedy one would
 * read "*waves* then *grins*" as one action and swallow the middle pair; that line breaks
 * the convention, so it is left exactly as typed.
 */
const ACTION = /^\*([^*]+)\*$/;

export function readAction(text: string): { body: string; action: boolean } {
  const m = text.trim().match(ACTION);
  return m ? { body: m[1].trim(), action: true } : { body: text, action: false };
}

/**
 * The sender prefixes. `rep` and `me` are the user-facing vocabulary; the internal `Sender`
 * values stay `"received"` / `"sent"` because that is what the palette and the alignment are
 * keyed on, and this rename is deliberately confined to the parsing boundary so the
 * colour/side mapping keeps a zero diff.
 */
const PREFIX = /^(rep|me|r|m)::?\s*/i;

/**
 * Parses the multi-message `text` param.
 *
 * The param vocabulary has no array type, so several messages ride in one string — the same
 * problem orbit-headline-Rep solves with "|" for phrase breaks. Here each message is one
 * line (or one "|"-separated part, since not every path into a text param is guaranteed to
 * preserve newlines), optionally prefixed with its sender:
 *
 *     rep: hey, are you around?
 *     me: just got back - what's up
 *     rep: tell me everything
 *
 * - `rep:` / `me:`, or the short `r:` / `m:`, case-insensitive. "rep" is the received side
 *   (short for the product name); "me" is the sent side, which is also what the source
 *   called it internally (`from === "me"`).
 * - No prefix: alternate from the previous message, starting with `rep`. So a bare list of
 *   lines is a back-and-forth without any markup at all.
 * - A doubled colon escapes: `me:: no really` is a message whose text is "me: no really".
 * - Blank lines are ignored, so paragraph spacing in the param does not create empty bubbles.
 * - `*wrapped in asterisks*` marks a roleplay action (see readAction).
 */
export function parseThread(text: string): ChatMessage[] {
  const parts = text
    .split(/\r?\n|\|/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const messages: ChatMessage[] = [];
  for (const part of parts) {
    const match = part.match(PREFIX);
    let from: Sender;
    let body: string;
    if (match) {
      const escaped = match[0].includes("::");
      if (escaped) {
        // Doubled colon: strip one colon, keep the word as literal text, and fall through
        // to the alternating rule for the sender.
        body = part.replace("::", ":");
        from = nextSender(messages);
      } else {
        const marker = match[1].toLowerCase();
        // "me"/"m" is the sent side; "rep"/"r" the received one.
        from = marker === "m" || marker === "me" ? "sent" : "received";
        body = part.slice(match[0].length);
      }
    } else {
      from = nextSender(messages);
      body = part;
    }
    const { body: stripped, action } = readAction(body);
    if (stripped.length === 0) continue;
    messages.push({ from, text: stripped, action });
  }
  return messages;
}

/** Alternate from the previous message; an unmarked thread opens with a "rep" line. */
function nextSender(messages: ChatMessage[]): Sender {
  const last = messages[messages.length - 1];
  if (!last) return "received";
  return last.from === "received" ? "sent" : "received";
}

/**
 * Lays the messages out on the clock.
 *
 * The pause belongs to the message that is ABOUT to arrive, not to the one that just did,
 * which is what lets a delay mean one thing wherever it lands. The first message skips its
 * pause — the lead-in already covers it.
 *
 * `pace` scales the pauses only (lead-in, reaction beats, user delays, typing, and the tail
 * hold). The 240ms entrance is fixed; see ENTER.
 */
export function buildTimeline(messages: ChatMessage[], pace = 1): Timeline {
  let cursor = LEAD_IN * pace;
  const landed: { message: ChatMessage; appearAt: number; typingFrom: number | null }[] = [];

  messages.forEach((message, i) => {
    if (message.from === "received") {
      if (i > 0) cursor += SHE_REACTS * pace;
      const typingFrom = cursor;
      const appearAt = cursor + typingFor(message.text) * pace;
      landed.push({ message, appearAt, typingFrom });
      cursor = appearAt + ENTER;
    } else {
      if (i > 0) cursor += USER_DELAY * pace;
      landed.push({ message, appearAt: cursor, typingFrom: null });
      cursor += ENTER;
    }
  });

  // The hold, then the wave out: oldest bubble first, one EXIT_STAGGER apart. The stack is
  // NOT re-laid-out as bubbles go — they leave from where they sit, or the survivors would
  // jump around mid-wave.
  const exitFrom = cursor + HOLD_OUT * pace;
  const items: TimedMessage[] = landed.map((entry, i) => ({
    ...entry,
    exitAt: exitFrom + i * EXIT_STAGGER,
  }));
  const lastExitAt = items.length > 0 ? items[items.length - 1].exitAt : exitFrom;

  return { items, exitFrom, duration: lastExitAt + EXIT };
}

/**
 * The pace factor that makes a thread last exactly `target` seconds.
 *
 * Solved rather than applied blind, because the entrances do not scale: the fixed cost is
 * ENTER per message, and only the remainder is elastic. Below the fixed cost there is
 * nothing left to compress, so the factor floors at a small positive value and the clip
 * simply runs longer than asked — reporting a wrong duration would be worse than
 * overrunning one.
 */
export function paceFor(messages: ChatMessage[], target: number): number {
  const natural = buildTimeline(messages, 1).duration;
  // Fixed: every entrance, the whole staggered exit. Only the pauses are elastic, so the
  // exit is structurally unclippable — a tight duration squeezes the hold and the
  // conversational beats instead.
  const fixed =
    messages.length * ENTER +
    Math.max(0, messages.length - 1) * EXIT_STAGGER +
    EXIT;
  const elastic = natural - fixed;
  if (elastic <= 0) return 1;
  return Math.max(0.05, (target - fixed) / elastic);
}

// ── Easing ──────────────────────────────────────────────────────────────────
// The house ease-out, cubic-bezier(0.23, 1, 0.32, 1), evaluated in JS because the render
// samples the animation at arbitrary instants. A real solver fed the real control points,
// not an approximation of the curve's shape — a hand-rolled cubic or a back-out formula
// would drift from what the rest of the interface does.
//
// Newton-Raphson, four iterations, exactly as the source (and the browser) does it. This
// library's curves.ts uses bisection instead, because the Lottie handles it carries include
// cubic-bezier(1, 0, 1, 1), whose vanishing derivative makes Newton wander; that is not a
// risk at (0.23, 1, 0.32, 1), and matching the source's method keeps the two numerically
// identical rather than merely close.

const bezier = (t: number, a: number, b: number) => {
  const c = 3 * a;
  const d = 3 * (b - a) - c;
  const e = 1 - c - d;
  return ((e * t + d) * t + c) * t;
};
const bezierSlope = (t: number, a: number, b: number) => {
  const c = 3 * a;
  const d = 3 * (b - a) - c;
  const e = 1 - c - d;
  return (3 * e * t + 2 * d) * t + c;
};

export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  return (p: number): number => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 4; i += 1) {
      const slope = bezierSlope(t, x1, x2);
      if (slope === 0) break;
      t -= (bezier(t, x1, x2) - p) / slope;
    }
    return bezier(t, y1, y2);
  };
}

/** cubic-bezier(0.23, 1, 0.32, 1) — the house ease-out. */
export const easeOut = cubicBezier(0.23, 1, 0.32, 1);

/** 0 -> 1 over the bubble's entrance, then pinned at 1. */
export function enterProgress(t: number, appearAt: number): number {
  if (t <= appearAt) return 0;
  if (t >= appearAt + ENTER) return 1;
  return (t - appearAt) / ENTER;
}

/**
 * 0 -> 1 over the bubble's exit, then pinned at 1 (fully gone).
 *
 * The mirror of enterProgress. Feeding `1 - this` back through the entrance easing and
 * transform is what makes the exit a time reversal rather than a lookalike — see
 * exitTransform.
 */
export function exitProgress(t: number, exitAt: number): number {
  if (t <= exitAt) return 0;
  if (t >= exitAt + EXIT) return 1;
  return (t - exitAt) / EXIT;
}

/** Is she typing at time t, and has that line not landed yet? */
export function isTyping(item: TimedMessage, t: number): boolean {
  return item.typingFrom !== null && t >= item.typingFrom && t < item.appearAt;
}

// ── Typing dots ─────────────────────────────────────────────────────────────

/** Seconds for one dot to complete its cycle. */
export const DOT_PERIOD = 1.15;
/**
 * Per-dot offset — a fraction of a CYCLE, not seconds.
 *
 * The source adds it to the phase, `(t/PERIOD + index*STAGGER) % 1`, so the wall-clock
 * offset is 0.16 x 1.15 = 0.184s. The extraction report read it as 0.16s; kept in phase
 * units here so the arithmetic matches the source exactly.
 */
export const DOT_STAGGER = 0.16;
export const DOT_SIZE = 7;
/** Gap between the dots, and the height of the row they sit in. */
export const DOT_GAP = 5;
export const DOT_ROW_HEIGHT = 19;

/** Opacity and scale of one dot at time `t`. */
export function dotState(t: number, index: number): { opacity: number; scale: number } {
  const phase = (t / DOT_PERIOD + index * DOT_STAGGER) % 1;
  // A cosine, shifted so the dot is at its dimmest when its cycle starts.
  const wave = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
  return { opacity: 0.32 + 0.68 * wave, scale: 0.7 + 0.3 * wave };
}
