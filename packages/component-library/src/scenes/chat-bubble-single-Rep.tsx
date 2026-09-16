/**
 * chat-bubble-single-Rep — one Replika chat bubble, arriving.
 *
 * A port of ui-animation's balloon bubble: the 8-anchor Bézier silhouette (see
 * lib/balloon-geometry.ts) with the house entrance — 240ms on cubic-bezier(0.23, 1, 0.32, 1),
 * fading, rising 10px and growing from 0.94, anchored to the corner the bubble belongs to.
 *
 * The exit is the entrance played backwards — the same ported transform, mirrored in time
 * (see exitTransform). The source has no exit at all, so this half is new design; its shape
 * is inherited rather than invented, which is why it reuses that one function instead of
 * having a curve of its own.
 *
 * Both halves are a fixed 240ms and do NOT stretch with durationInSeconds — see ENTER in
 * lib/chat-timeline.ts for why. The hold between them takes up the slack.
 */
import { Node, makeScene2D } from "@motion-canvas/2d";
import { createSignal, tween, useScene } from "@motion-canvas/core";

import {
  COLUMN_W,
  applyShadowScale,
  buildBubbleNode,
  entranceTransform,
  exitTransform,
} from "../lib/balloon-bubble";
import {
  EXIT,
  easeOut,
  enterProgress,
  exitProgress,
  readAction,
  type Sender,
} from "../lib/chat-timeline";
import { FONT_FAMILY, FONT_URL } from "../lib/chat-font";
import { ensureFont } from "../lib/text-measure";

/** Share of the frame the column is allowed to occupy. */
const FIT_MARGIN = 0.9;

/**
 * Reads the `sender` param: `rep` (the companion) or `me` (the user), matching
 * chat-thread-Rep's line prefixes, with the same short forms.
 *
 * Strict on purpose. The previous version took anything starting with "s" as the sent side,
 * which would have gone on silently accepting the old `"sent"` / `"received"` values as
 * undocumented aliases — and an unrecognised value would have quietly rendered as the
 * companion, i.e. the wrong colour and the wrong side with nothing to show it. The internal
 * `Sender` values stay `"received"` / `"sent"`: the palette and the alignment are keyed on
 * them, so this is a rename of the param's vocabulary only.
 */
function readSender(raw: string): Sender {
  const value = raw.trim().toLowerCase();
  if (value === "me" || value === "m") return "sent";
  if (value === "rep" || value === "r") return "received";
  throw new Error(
    `[chat-bubble] sender "${raw}" is not a valid value — use "rep" (the companion) or ` +
      `"me" (the user), or the short "r" / "m". The older "received" / "sent" names were ` +
      `renamed; see the param description.`,
  );
}

export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const rawText = String(variables.get("text", "Hey, are you around?")());
  const sender = readSender(String(variables.get("sender", "rep")()));
  const totalDuration = Number(variables.get("durationInSeconds", 2.5)());

  // Before anything is measured: a fallback font would give the text a different width and
  // the silhouette would be drawn to match, with nothing visibly wrong. Throws rather than
  // rendering in the wrong typeface.
  yield ensureFont(FONT_FAMILY, FONT_URL);

  const { body, action } = readAction(rawText);
  const bubble = buildBubbleNode(body, sender, action, { fontFamily: FONT_FAMILY });

  const frame = view.size();
  const zoom = Math.min(
    (frame.x * FIT_MARGIN) / COLUMN_W,
    (frame.y * FIT_MARGIN) / bubble.height,
  );

  // Canvas shadows are not transformed by the node's scale, so they are rescaled for the
  // zoom here rather than at build time. See applyShadowScale.
  applyShadowScale(bubble, zoom);

  /** Seconds into the clip. Every property below reads this. */
  const now = createSignal(0);

  // Aligned to its own side of the column, exactly as the thread lays it out, so a single
  // bubble sits where the same message would in a conversation.
  const restX =
    sender === "sent" ? COLUMN_W / 2 - bubble.width / 2 : -COLUMN_W / 2 + bubble.width / 2;

  /**
   * When the bubble starts leaving, so that it has finished by the end of the clip.
   *
   * The hold is what shrinks to make room. Below ENTER + EXIT (0.48s) there is no hold left
   * and the ENTRANCE is what gets truncated — the exit is never clipped, since a clip that
   * ends mid-disappearance looks broken in a way a slightly clipped arrival does not. The
   * param's own minimum is 0.5s, so the validated range never reaches that.
   */
  const exitAt = Math.max(0, totalDuration - EXIT);

  /** Entrance, hold, then the entrance in reverse — one transform, read in both directions. */
  const phase = () => {
    const t = now();
    if (t >= exitAt) {
      return exitTransform(exitProgress(t, exitAt), sender, bubble.width, bubble.height);
    }
    return entranceTransform(
      easeOut(enterProgress(t, 0)),
      sender,
      bubble.width,
      bubble.height,
    );
  };

  bubble.node.x(() => restX + phase().x);
  bubble.node.y(() => phase().y);
  bubble.node.scale(() => phase().scale);
  bubble.node.opacity(() => phase().opacity);

  view.add(<Node scale={zoom}>{bubble.node}</Node>);

  // One tween across the whole clip: entrance, hold and exit are all read from `now`, so
  // there is no seam between them to get the phase boundaries wrong at.
  yield* tween(totalDuration, (value) => now(value * totalDuration));
  now(totalDuration);
});
