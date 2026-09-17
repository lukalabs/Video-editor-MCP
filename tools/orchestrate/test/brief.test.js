import assert from "node:assert/strict";
import { test } from "node:test";

import { briefLines, clipSeconds, renderCost } from "../brief.js";

const plan = {
  title: "A Test",
  steps: ["ui-snap", "ugc-farm", "captions", "button", "packshot"],
  ugc: {
    script: "One two three four five six seven eight.",
    action: "She stands in a room.",
    screen_describes: "A memory screen.",
    durationSeconds: 0,
  },
  captions: { preset: "hormozi" },
  button: { leadSeconds: 3, props: { label: "Go", animation: "popIn", easing: "springy", positionY: 0.85 } },
  packshot: { media: "storage/media/logo.mp4" },
  notes: [],
};
const flags = { resolution: "1080p", captions: "overlay", buttonLead: 0, duration: 0 };

test("a stated duration is used exactly, and says so", () => {
  assert.deepEqual(clipSeconds({ ugc: { durationSeconds: 8 } }, flags), { seconds: 8, exact: true });
});

test("the flag beats what the planner read out of the prompt", () => {
  const asked = clipSeconds({ ugc: { durationSeconds: 8 } }, { ...flags, duration: 12 });
  assert.deepEqual(asked, { seconds: 12, exact: true });
});

test("with no duration anywhere the length is an estimate, never presented as exact", () => {
  const { seconds, exact } = clipSeconds(plan, flags);
  assert.equal(exact, false);
  assert.ok(seconds >= 4, "the model's own floor still applies");
});

test("an empty script does not invent a length", () => {
  assert.deepEqual(clipSeconds({ ugc: { script: "" } }, flags), { seconds: 0, exact: false });
});

test("cost is seconds times the measured rate", () => {
  assert.deepEqual(renderCost(10, "1080p"), { tokens: 487000, rate: 48700 });
  assert.deepEqual(renderCost(10, "720p"), { tokens: 216000, rate: 21600 });
});

test("an unmeasured resolution reports no cost rather than a guess", () => {
  assert.equal(renderCost(10, "480p"), null);
});

test("the brief marks exactly one step as paid", () => {
  const paid = briefLines(plan, flags).filter((l) => l.includes("PAID"));
  assert.equal(paid.length, 1);
  assert.ok(paid[0].includes("ugc-farm"));
});

test("every step in the plan is numbered in the brief", () => {
  const lines = briefLines(plan, flags);
  for (const [i, name] of plan.steps.entries()) {
    assert.ok(lines.some((l) => l.startsWith(`  ${i + 1}) ${name}`)), `${name} is missing`);
  }
});

test("a step left out of the plan is left out of the brief", () => {
  const lines = briefLines({ ...plan, steps: ["ui-snap", "ugc-farm"] }, flags).join("\n");
  assert.ok(!lines.includes("packshot"));
  assert.ok(lines.includes("ugc-farm"));
});

test("the spoken words appear in the brief, because they are what gets bought", () => {
  assert.ok(briefLines(plan, flags).join("\n").includes("seven eight"));
});

test("an estimated length says the cost moves with it; an exact one does not", () => {
  const guessed = briefLines(plan, flags).join("\n");
  const stated = briefLines({ ...plan, ugc: { ...plan.ugc, durationSeconds: 8 } }, flags).join("\n");
  assert.ok(guessed.includes("estimate"));
  assert.ok(!stated.includes("the cost moves with it"));
});
