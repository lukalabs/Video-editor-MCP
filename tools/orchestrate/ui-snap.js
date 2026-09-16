/**
 * The Replika screen that appears on the phone in the shot.
 *
 * ui-snap already has the endpoint: POST /api/shot takes the screen's contents as
 * JSON and drives the Chrome on this machine to photograph the real page. We send
 * the state the planner wrote and keep the PNG.
 *
 * Two things this file is careful about:
 *
 * - ui-snap coerces a bad value instead of refusing it. An https:// image, an
 *   unknown fact source, an over-long line — all quietly replaced by its own
 *   sample data. A plausible-but-wrong screenshot is worse than an error, so the
 *   body is checked here and anything suspect is said out loud.
 * - the shot is taken with `omitBackground`, so it can carry transparency, and
 *   ugc-farm re-encodes whatever it gets with `format=yuvj420p`, which drops alpha
 *   rather than compositing it — transparent would arrive black. So it is
 *   flattened here, onto the board's own background colour.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { StepError, ffprobe, request, sh } from "./lib.js";

const FACT_SOURCES = ["conversation", "email", "calendar"];

/** Everything ui-snap would swallow, said out loud instead. */
export function inspect(state) {
  const complaints = [];
  const image = (value, where) => {
    if (value && !String(value).startsWith("/memory/") && !String(value).startsWith("data:image/")) {
      complaints.push(`${where}: "${value}" is not a /memory/ path, so ui-snap will use its own picture instead`);
    }
  };
  if (!state.owner || typeof state.owner !== "object") complaints.push("owner is missing — ui-snap answers 400");
  if (!Array.isArray(state.arcs)) complaints.push("arcs is missing — ui-snap answers 400");

  image(state.owner?.avatar, "owner.avatar");
  for (const arc of state.arcs ?? []) {
    image(arc.image, `arc ${arc.id}`);
    if ((arc.title ?? "").length > 80) complaints.push(`arc ${arc.id}: title over 80 characters, will be cut`);
    for (const fact of arc.facts ?? []) {
      if (!FACT_SOURCES.includes(fact.source)) {
        complaints.push(`fact ${fact.id}: source "${fact.source}" becomes "conversation"`);
      }
      if ((fact.text ?? "").length > 500) complaints.push(`fact ${fact.id}: text over 500 characters, will be cut`);
    }
  }
  if (state.screen === "arc" && !(state.arcs ?? []).some((a) => a.id === state.openArcId)) {
    complaints.push(`openArcId "${state.openArcId}" matches no arc, so the home screen renders instead`);
  }
  return complaints;
}

/**
 * Paint the shot onto an opaque background.
 *
 * In practice the Memory board already fills the frame, so this is usually a
 * no-op — which is the point. Doing it makes that provable rather than hoped for,
 * and stops a future rounded corner shipping black edges into the render.
 */
export function flatten(source, destination, color) {
  const { width, height } = ffprobe(source);
  if (!width || !height) throw new StepError(`could not read ${source}`);
  const fill = `0x${color.replace("#", "")}`;
  sh("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${fill}:s=${width}x${height}`,
    "-i", source,
    "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto,format=rgb24",
    "-frames:v", "1", destination,
  ]);
  const after = ffprobe(destination);
  if (after.pixFmt !== "rgb24") {
    throw new StepError(`flattening left ${destination} as ${after.pixFmt}, not rgb24`);
  }
  return after;
}

/**
 * @returns {Promise<{shot: string, screen: string, width: number, height: number, warnings: string[]}>}
 */
export async function shoot(state, { baseUrl, dir, flattenColor, log }) {
  const warnings = inspect(state);
  for (const complaint of warnings) log(`  ! ${complaint}`);

  // The route declares maxDuration 60 and spends it on a page load plus a wait for
  // the fonts, so anything less than that is our impatience, not its slowness.
  const answer = await request(`${baseUrl}/api/shot`, {
    method: "POST",
    body: state,
    timeoutMs: 75000,
    raw: true,
  });

  if (!answer.ok) {
    // ui-snap answers errors as plain text, not JSON.
    const detail = answer.bytes.toString("utf8").slice(0, 300);
    if (answer.status === 400) {
      throw new StepError(`ui-snap refused the screen state: ${detail}`, {
        code: "bad_state",
        hint: "owner must be an object and arcs an array",
        fatal: true,
      });
    }
    throw new StepError(`ui-snap could not take the shot (${answer.status}): ${detail}`);
  }

  const shot = join(dir, "shot.png");
  writeFileSync(shot, answer.bytes);
  const raw = ffprobe(shot);
  log(`  shot    ${raw.width}x${raw.height}, ${(answer.bytes.length / 1e6).toFixed(1)} MB, ${raw.pixFmt}`);

  const screen = join(dir, "screen.png");
  const flat = flatten(shot, screen, flattenColor);
  log(`  flat    ${flat.width}x${flat.height}, ${flat.pixFmt} on ${flattenColor}`);

  return { shot, screen, width: flat.width, height: flat.height, warnings };
}
