import assert from "node:assert/strict";
import { test } from "node:test";

import { StepError } from "../lib.js";
import { coerce, readable, readTags, resolveSteps, stripTags, STEPS } from "../plan.js";

test("tags are read out of the prose, in canonical order", () => {
  assert.deepEqual(readTags("do @packshot and @ui-snap please"), ["ui-snap", "packshot"]);
  assert.deepEqual(readTags("no tags here"), []);
  // A bare @ or an unknown tag is prose, not routing.
  assert.deepEqual(readTags("@nope @button"), ["button"]);
});

test("the model reads the sentence, not the routing", () => {
  assert.equal(stripTags("@ui-snap make a video @button now"), "make a video now");
});

test("tags win over whatever the model proposed", () => {
  const { steps } = resolveSteps({ tags: ["button", "packshot"], proposed: STEPS, hasMedia: true });
  assert.deepEqual(steps, ["button", "packshot"]);
});

test("a screenshot with nothing to put it in pulls ugc-farm along", () => {
  const { steps, warnings } = resolveSteps({ tags: ["ui-snap"], proposed: [], hasMedia: false });
  assert.deepEqual(steps, ["ui-snap", "ugc-farm"]);
  assert.match(warnings[0], /nothing else uses the screenshot/);
});

test("editing steps with no clip and no way to make one is an error, not a guess", () => {
  assert.throws(
    () => resolveSteps({ tags: ["captions", "button"], proposed: [], hasMedia: false }),
    (error) => error instanceof StepError && /needs a clip/.test(error.message),
  );
  // …unless you brought your own clip.
  const { steps } = resolveSteps({ tags: ["captions", "button"], proposed: [], hasMedia: true });
  assert.deepEqual(steps, ["captions", "button"]);
});

test("no tags and nothing proposed runs the whole chain", () => {
  assert.deepEqual(resolveSteps({ tags: [], proposed: [], hasMedia: false }).steps, STEPS);
});

test("an unreadable button is corrected rather than shipped", () => {
  assert.equal(readable("#FFFFFF", "#FFFFFF"), "#141422");
  assert.equal(readable("#141422", "#FFFFFF"), "#141422");
  assert.equal(readable("#FFFFFF", "#FF4B6E"), "#FFFFFF");
  assert.equal(readable("", "#0B0B0F"), "#FFFFFF");
});

test("values ui-snap would silently replace are pinned first", () => {
  const plan = coerce({
    uiSnap: {
      screen: "arc",
      openArcId: "missing",
      arcs: [{ id: "a1", title: "x".repeat(200), blurb: "b", facts: [{ text: "f", source: "telepathy" }] }],
      owner: { name: "Sam" },
    },
    button: { props: { label: "Go", fillColor: "not-a-colour" } },
  });
  assert.equal(plan.uiSnap.arcs[0].title.length, 80, "a long title is cut, not rejected");
  assert.equal(plan.uiSnap.arcs[0].facts[0].source, "conversation", "an unknown source falls back");
  assert.equal(plan.uiSnap.arcs[0].facts[0].id, "f0", "a missing id gets one");
  assert.equal(plan.uiSnap.openArcId, "a1", "an openArcId pointing at nothing is repaired");
  assert.equal(plan.uiSnap.mockup, false, "no phone frame — the render wants screen contents only");
  assert.equal(plan.button.props.fillColor, "#FFFFFF", "a nonsense colour falls back");
});

test("an arc screen with no arcs falls back to home rather than a blank render", () => {
  const plan = coerce({ uiSnap: { screen: "arc", arcs: [], owner: {} } });
  assert.equal(plan.uiSnap.screen, "home");
  assert.equal(plan.uiSnap.openArcId, null);
});

test("caption preset and button animation are pinned to what the renderers know", () => {
  const plan = coerce({ captions: { preset: "tiktok" }, button: { props: { animation: "explode" } } });
  assert.equal(plan.captions.preset, "hormozi");
  assert.equal(plan.button.props.animation, "slideUp");
});
