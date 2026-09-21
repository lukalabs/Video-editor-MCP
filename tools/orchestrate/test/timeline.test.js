import assert from "node:assert/strict";
import { test } from "node:test";

import { StepError } from "../lib.js";
import { check, commands, describe as describePlan, layout } from "../timeline.js";

const PACKSHOT = 4.066667;

test("one clip: the button ends exactly where the packshot starts", () => {
  const plan = layout({ parts: [22.0], packshot: PACKSHOT, button: 5.04 });
  assert.deepEqual(plan.clips, [{ part: 1, at: 0, duration: 22 }]);
  assert.equal(plan.button.at, 16.96);
  assert.equal(plan.packshot.at, 22);
  assert.equal(plan.button.at + plan.button.duration, plan.packshot.at);
  assert.deepEqual(check(plan), []);
});

test("three clips: each starts where the last ended, and the button sits on the last one", () => {
  const plan = layout({ parts: [24, 26, 18], packshot: PACKSHOT, button: 5 });
  assert.deepEqual(plan.clips.map((c) => c.at), [0, 24, 50]);
  assert.equal(plan.footageEnd, 68);
  assert.equal(plan.button.at, 63);
  assert.equal(plan.packshot.at, 68);
  assert.equal(plan.end, 72.067);
  assert.deepEqual(check(plan), []);
});

test("the button's length is the file's, not the prop's", () => {
  // Asked for 5s, the encoder produced 5.208 — the button must still land on D.
  const plan = layout({ parts: [20], packshot: PACKSHOT, button: 5.208 });
  assert.equal(plan.button.at, 14.792);
  assert.equal(plan.button.at + plan.button.duration, 20);
  assert.deepEqual(check(plan), []);
});

test("a button longer than the footage is refused, not clamped", () => {
  assert.throws(
    () => layout({ parts: [4], packshot: PACKSHOT, button: 5 }),
    (error) => error instanceof StepError && /only 4s/.test(error.message),
  );
});

test("a button that straddles the cut between two clips is caught", () => {
  const plan = layout({ parts: [24, 6], packshot: PACKSHOT, button: 5 });
  assert.deepEqual(check(plan), [], "5s fits inside the 6s last clip");

  const straddles = layout({ parts: [24, 6], packshot: PACKSHOT, button: 6 });
  assert.deepEqual(check(straddles), []);

  // Hand-built: a button reaching back past the last clip's start.
  const bad = { ...straddles, button: { at: 20, duration: 10 } };
  assert.match(check(bad).join(" "), /straddle the cut/);
});

test("an overlap is reported with both numbers, not just a boolean", () => {
  const plan = layout({ parts: [20], packshot: PACKSHOT, button: 5 });
  plan.button.at = 17;          // pushed forward by hand: now it runs past D
  assert.match(check(plan).join(" "), /would play over the end card/);
});

test("no packshot and no button still produces a valid one-clip timeline", () => {
  const plan = layout({ parts: [12.5] });
  assert.equal(plan.button, null);
  assert.equal(plan.packshot, null);
  assert.equal(plan.end, 12.5);
  assert.deepEqual(check(plan), []);
});

test("a clip ffprobe could not read is refused", () => {
  assert.throws(() => layout({ parts: [0] }), (e) => /ffprobe could not read/.test(e.message));
  assert.throws(() => layout({ parts: [] }), (e) => /no footage/.test(e.message));
});

test("the commands put the footage down before anything is placed against it", () => {
  const plan = layout({ parts: [20, 8], packshot: PACKSHOT, button: 5 });
  const calls = commands(plan, {
    project: "d.json", media: ["p1.mp4", "p2.mov"], packshotMedia: "logo.mp4",
    buttonFile: "b.webm", buttonProps: { label: "Go" }, cues: "cues.json",
    captions: "overlay", preset: "hormozi", backdrop: "#0B0B0F",
    width: 1080, height: 1920, fps: 30, name: "test",
  });
  const verbs = calls.map((c) => c[0]);
  assert.deepEqual(verbs, ["new", "add-clip", "add-clip", "add-clip", "background", "subtitles", "component"]);
  assert.ok(verbs.indexOf("add-clip") < verbs.indexOf("component"));

  // Every clip carries an explicit --at; without one they all pile onto zero.
  for (const call of calls.filter((c) => c[0] === "add-clip")) {
    assert.ok(call.includes("--at"), `missing --at: ${call.join(" ")}`);
  }
  assert.deepEqual(calls[1].slice(-2), ["--at", "0"]);
  assert.deepEqual(calls[2].slice(-2), ["--at", "20"]);
  assert.deepEqual(calls[3].slice(-2), ["--at", "28"]);
  assert.deepEqual(calls[6].slice(4, 6), ["--file", "b.webm"]);
});

test("--captions layer adds the flag, none skips the step", () => {
  const plan = layout({ parts: [10] });
  const base = {
    project: "d.json", media: ["p1.mp4"], packshotMedia: "logo.mp4",
    buttonFile: "", buttonProps: {}, cues: "cues.json",
    preset: "hormozi", backdrop: "#000000", width: 1080, height: 1920, fps: 30, name: "t",
  };
  assert.ok(commands(plan, { ...base, captions: "layer" }).some((c) => c.includes("--layer")));
  assert.ok(!commands(plan, { ...base, captions: "overlay" }).some((c) => c.includes("--layer")));
  assert.ok(!commands(plan, { ...base, captions: "none" }).some((c) => c[0] === "subtitles"));
});

test("the printed layout shows the gap", () => {
  const text = describePlan(layout({ parts: [20], packshot: PACKSHOT, button: 5 }));
  assert.match(text, /gap\s+0s/);
  assert.match(text, /total\s+24\.067s/);
});
