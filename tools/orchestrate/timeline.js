/**
 * Where everything sits on the timeline, and the project-cli calls that put it there.
 *
 * The one thing this file exists to get right: the CTA button sits on the last
 * seconds of the footage, and the packshot comes after it. They must not overlap.
 *
 * Nothing mechanical enforces that. They land on different tracks — graphics and
 * video — and the editor's overlap check is per-track, so it will never complain.
 * Only the arithmetic here keeps them apart, so the arithmetic is checked out loud.
 *
 * Two rules follow from that:
 *
 * 1. Every time is absolute. project-cli reads a negative `--at` as "back from the
 *    end of the timeline", and the end moves when the packshot is added and again
 *    when subtitles are — so the same `--at -5` means three different things
 *    depending on when it runs. We already know the durations; we use them.
 * 2. The button is placed at `D - B`, where B is the rendered file's own length,
 *    not the `durationInSeconds` prop. project-cli has no `--duration` for a
 *    component: the clip is as long as the webm. Measuring it first is what makes
 *    the button end exactly where the packshot begins.
 */
import { StepError, round } from "./lib.js";

/** project-kit's own tolerance for "these two clips touch but do not overlap". */
export const EPSILON = 1e-4;

/**
 * @param {{parts: number[], packshot: number, button: number}} lengths seconds
 */
export function layout({ parts, packshot = 0, button = 0 }) {
  if (!parts.length) throw new StepError("no footage to build a timeline from");

  const starts = [];
  let at = 0;
  for (const length of parts) {
    if (!(length > 0)) throw new StepError(`a clip reports ${length}s — ffprobe could not read it`);
    starts.push(round(at));
    at += length;
  }
  const footageEnd = round(at);

  const plan = {
    clips: parts.map((length, i) => ({ part: i + 1, at: starts[i], duration: round(length) })),
    footageEnd,
    lastPartStart: starts[starts.length - 1],
    button: null,
    packshot: null,
    end: footageEnd,
  };

  if (button > 0) {
    if (button > footageEnd + EPSILON) {
      throw new StepError(
        `the button is ${round(button)}s but the footage is only ${footageEnd}s`,
        { hint: "lower --button-lead, or the button would start before the video does" },
      );
    }
    plan.button = { at: round(footageEnd - button), duration: round(button) };
  }
  if (packshot > 0) {
    plan.packshot = { at: footageEnd, duration: round(packshot) };
    plan.end = round(footageEnd + packshot);
  }
  return plan;
}

/**
 * The three things that must be true. Returned rather than thrown so `run.js` can
 * print the numbers next to the verdict — a silent pass teaches nobody anything.
 */
export function check(plan) {
  const problems = [];
  if (plan.button && plan.packshot) {
    const buttonEnd = plan.button.at + plan.button.duration;
    if (buttonEnd > plan.packshot.at + EPSILON) {
      problems.push(
        `the button runs to ${round(buttonEnd)}s but the packshot starts at ${plan.packshot.at}s `
        + `— it would play over the end card`,
      );
    }
  }
  if (plan.button && plan.button.at < plan.lastPartStart - EPSILON) {
    problems.push(
      `the button starts at ${plan.button.at}s, before the last clip does at ${plan.lastPartStart}s `
      + "— it would straddle the cut",
    );
  }
  const expected = plan.packshot ? round(plan.packshot.at + plan.packshot.duration) : plan.footageEnd;
  if (Math.abs(expected - plan.end) > 1e-3) {
    problems.push(`the timeline should end at ${expected}s but the plan says ${plan.end}s`);
  }
  return problems;
}

/** The same numbers, laid out so you can see the gap is zero. */
export function describe(plan) {
  const span = (label, thing) =>
    `  ${label.padEnd(9)} [${String(thing.at).padStart(7)}, ${String(round(thing.at + thing.duration)).padStart(7)}]`;
  const lines = plan.clips.map((clip) => span(`clip ${clip.part}`, clip));
  if (plan.button) lines.push(span("button", plan.button));
  if (plan.packshot) lines.push(span("packshot", plan.packshot));
  if (plan.button && plan.packshot) {
    const gap = round(plan.packshot.at - (plan.button.at + plan.button.duration));
    lines.push(`  ${"gap".padEnd(9)} ${gap}s between the button and the end card`);
  }
  lines.push(`  ${"total".padEnd(9)} ${plan.end}s`);
  return lines.join("\n");
}

/**
 * The project-cli commands, in the order they have to run.
 *
 * Order matters in one place only: the footage goes down before anything is placed
 * against it. Everything else is absolute, so it could run in any order — it is
 * written front-to-back because that is how it reads.
 */
export function commands(plan, {
  project, media, packshotMedia, buttonFile, buttonProps,
  cues, captions, preset, backdrop, width, height, fps, name,
}) {
  const out = [["new", project, "--size", `${width}x${height}`, "--fps", String(fps), "--name", name]];

  plan.clips.forEach((clip, i) => {
    // A clip with no --at goes to 0, and the second one then collides with the first.
    out.push(["add-clip", project, "--media", media[i], "--at", String(clip.at)]);
  });

  if (plan.packshot) {
    out.push(["add-clip", project, "--media", packshotMedia, "--at", String(plan.packshot.at)]);
    // The packshot is landscape in a vertical frame, so it arrives in bars. An
    // explicit colour, not `auto`: `auto` samples the first footage clip — a room,
    // whose corners disagree — rather than the end card.
    out.push(["background", project, "--color", backdrop]);
  }

  if (cues && captions !== "none") {
    const call = ["subtitles", project, "--cues", cues, "--preset", preset];
    if (captions === "layer") call.push("--layer");
    out.push(call);
  }

  if (plan.button) {
    // --props alongside --file: the file is what gets used, the props are what let
    // you re-render the button from inside the editor later.
    out.push(["component", project, "--component", "button", "--file", buttonFile,
      "--at", String(plan.button.at), "--props", JSON.stringify(buttonProps)]);
  }
  return out;
}
