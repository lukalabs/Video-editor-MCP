/**
 * Your sentence, turned into a step plan.
 *
 * Two ways to steer it. Tags (`@ui-snap`, `@ugc-farm`, `@captions`, `@button`,
 * `@packshot`) decide which steps run, and are read here before the model is asked
 * anything — so routing is deterministic whatever the prose says. The model's job
 * is the parameters: the script, the scene, the memory text, the button label.
 *
 * It always fills every block, even for steps that will not run. That is what lets
 * `--only` and `resume` re-enter the chain anywhere without re-planning.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { STEPS, StepError, request } from "./lib.js";

export { STEPS };
const TAG = /@(ui-snap|ugc-farm|captions|button|packshot)\b/g;

const CAPTION_PRESETS = ["hormozi", "clean", "bounce", "boxed", "highlight-box"];
const ANIMATIONS = ["fadeIn", "popIn", "lift", "slideUp", "press", "pulse"];
const EASINGS = ["soft", "snappy", "springy", "even"];
const FACT_SOURCES = ["conversation", "email", "calendar"];

/* --------------------------------------------------------------- the schema */

const STEP_PLAN_SCHEMA = {
  type: "object",
  required: ["title", "steps", "ugc", "uiSnap", "captions", "button", "packshot"],
  properties: {
    title: { type: "string", description: "A short name for this video, 2-5 words." },
    steps: { type: "array", items: { type: "string", enum: STEPS } },

    ugc: {
      type: "object",
      required: ["script", "action", "screen_describes"],
      properties: {
        script: {
          type: "string",
          description:
            "The spoken words, verbatim, and nothing else. No speaker labels, no "
            + "parentheticals, no stage directions, no emoji markers.",
        },
        action: {
          type: "string",
          description:
            "Only what a camera in the room would record: who is there, how they "
            + "look, the place, the time of day, what they do with their hands and "
            + "body. Never overlays, captions, subtitles, buttons, CTAs, end cards, "
            + "logos, packshots, edits or cuts.",
        },
        screen_in_shot: { type: "boolean" },
        screen_describes: {
          type: "string",
          description:
            "What is on the phone screen, in one sentence, as screen contents only "
            + "— never its shape, its proportions, a phone body or a background.",
        },
      },
    },

    uiSnap: {
      type: "object",
      required: ["companionName", "screen", "owner", "arcs"],
      properties: {
        companionName: { type: "string" },
        screen: { type: "string", enum: ["home", "arc", "person"] },
        openArcId: { type: "string" },
        owner: {
          type: "object",
          required: ["name", "relation"],
          properties: {
            name: { type: "string" },
            relation: { type: "string" },
            metOn: { type: "string" },
            chips: { type: "array", items: { type: "string" } },
            paragraphs: { type: "array", items: { type: "string" } },
          },
        },
        arcs: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "blurb", "facts"],
            properties: {
              id: { type: "string" },
              title: { type: "string", description: "At most 80 characters." },
              blurb: { type: "string", description: "At most 600 characters." },
              facts: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "text", "date", "source"],
                  properties: {
                    id: { type: "string" },
                    text: { type: "string", description: "At most 500 characters." },
                    date: { type: "string", description: 'Like "Mar 3, 2026".' },
                    source: { type: "string", enum: FACT_SOURCES },
                  },
                },
              },
            },
          },
        },
      },
    },

    captions: {
      type: "object",
      required: ["preset"],
      properties: { preset: { type: "string", enum: CAPTION_PRESETS } },
    },

    button: {
      type: "object",
      required: ["leadSeconds", "props"],
      properties: {
        leadSeconds: { type: "number", description: "How long the button is on screen." },
        props: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string" },
            fillColor: { type: "string", description: "Hex, like #FF4B6E." },
            textColor: { type: "string" },
            positionY: { type: "number", description: "0 is the top, 1 the bottom." },
            animation: { type: "string", enum: ANIMATIONS },
            easing: { type: "string", enum: EASINGS },
          },
        },
      },
    },

    packshot: {
      type: "object",
      properties: { backdrop: { type: "string", description: "Hex for the letterbox bars." } },
    },

    notes: { type: "array", items: { type: "string" } },
  },
};

/* --------------------------------------------------------- the instructions */

const SYSTEM = `You turn one sentence from a video director into a structured plan
for a pipeline that makes short vertical ad creatives.

The pipeline has four stages and they must not be confused with each other:

  1. ui-snap   renders a Replika app screen as a picture
  2. ugc-farm  films an AI person saying a script, holding that screen
  3. captions  adds animated subtitles afterwards
  4. button + packshot  adds a tappable-looking CTA and an end card afterwards

FOUR RULES. The first two cost real money when broken.

RULE 1 — "action" is what the camera sees, and nothing else.
Stages 3 and 4 happen after filming. If you put them in "action", the video model
draws a fake button and burns in fake subtitles, underneath the real ones. So
"action" never contains the words button, CTA, subtitle, caption, text overlay,
end card, logo, packshot, edit, cut, or any instruction about timing on screen.
It contains: who is on camera, how they look, where they are, the time of day,
the light, and what they physically do — including picking up or holding a phone.

RULE 2 — "script" is spoken words only.
The number of words in it decides how many separate paid renders happen (over
about 45 words, it splits). A stage direction in there costs money. Strip speaker
names, parentheticals like "(laughs)", emoji and scene markers. Keep the words as
the director wrote them otherwise — do not improve them.

RULE 3 — "screen_describes" goes straight into the video prompt as the
description of the reference picture. Describe the contents of the screen and
never the object: not its shape, not its proportions, not a phone body, not a
background. One sentence.

RULE 4 — the screen's own values are validated and silently replaced if wrong.
"source" must be exactly one of conversation, email, calendar. At most 24 arcs.
Titles at most 80 characters, blurbs 600, fact text 500. Never invent image or
avatar paths; leave them out and the app's own pictures are used.

Other guidance:
- If the director's prompt describes a Replika Memory screen showing a particular
  fact, build one arc whose facts carry that text, set "screen" to "arc", and
  point "openArcId" at that arc's id.
- Pick a caption preset that matches the tone they asked for. "TikTok style",
  "Hormozi" or "bold" means hormozi. "Clean" or "minimal" means clean.
- The button's label is whatever text they put in brackets or quotes.
- Dates on memory facts should be recent — within the last few months of TODAY,
  which is ${new Date().toISOString().slice(0, 10)}. Write them like "Mar 3, 2026".
- "notes" is for anything the prompt left genuinely ambiguous, so a person can
  check your guess. Do not use it to restate what you did.`;

/* ---------------------------------------------------------------- the model */

/** Gemini's schema dialect is a subset. Ported from ugc/gemini.py::_gemini_schema:
 *  `additionalProperties` is rejected outright, and an empty string inside an enum
 *  is a 400 ("enum[2]: cannot be empty"). */
function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    if (key === "enum") {
      out[key] = value.filter((v) => v !== "");
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  return out;
}

/** Parse JSON out of a reply that may be fenced or prefaced. Structured output
 *  makes this unnecessary most of the time; a safety trim is when it is not. */
function parseJson(text) {
  const trimmed = text.trim().replace(/^```[a-z]*\n/, "").replace(/\n```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new StepError(`the planner returned no JSON:\n${trimmed.slice(0, 400)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Where the key came from, so `doctor` can say that without saying the key. */
export function findGeminiKey({ repo, ugcFarmDir }) {
  if (process.env.GEMINI_API_KEY) return { key: process.env.GEMINI_API_KEY, source: "the environment" };
  for (const [path, label] of [
    [resolve(repo, ".env"), "Video-editor-MCP/.env"],
    [resolve(ugcFarmDir, ".env"), "ugc-farm/.env"],
  ]) {
    const key = readEnvFile(path).GEMINI_API_KEY;
    if (key) return { key, source: label };
  }
  return { key: "", source: "" };
}

/* ------------------------------------------------------------------ routing */

export function readTags(prompt) {
  const found = new Set();
  for (const match of prompt.matchAll(TAG)) found.add(match[1]);
  return STEPS.filter((step) => found.has(step));
}

/** The prompt minus its tags — the model should read the sentence, not the routing. */
export const stripTags = (prompt) => prompt.replace(TAG, "").replace(/\s{2,}/g, " ").trim();

/**
 * Two invariants, whichever way the steps were chosen. Nothing else consumes the
 * screenshot, and there is nothing to edit without a clip.
 */
export function resolveSteps({ tags, proposed, hasMedia }) {
  let steps = tags.length ? tags : (proposed ?? []).filter((s) => STEPS.includes(s));
  if (!steps.length) steps = [...STEPS];
  const warnings = [];

  if (steps.includes("ui-snap") && !steps.includes("ugc-farm")) {
    steps.push("ugc-farm");
    warnings.push("added ugc-farm — nothing else uses the screenshot");
  }
  const editing = steps.filter((s) => ["captions", "button", "packshot"].includes(s));
  if (editing.length && !steps.includes("ugc-farm") && !hasMedia) {
    throw new StepError(
      `${editing.join(", ")} needs a clip to edit`,
      { hint: "add @ugc-farm to make one, or pass --media <file> to use one you have" },
    );
  }
  return { steps: STEPS.filter((s) => steps.includes(s)), warnings };
}

/* ----------------------------------------------------------------- the call */

export async function makePlan(prompt, { key, model, tags, hasMedia, timeoutMs = 120000 } = {}) {
  if (!key) {
    throw new StepError("no GEMINI_API_KEY", { hint: "run `orchestrate doctor` to see where it is looked for" });
  }
  const chosen = model || process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
  const routing = tags.length
    ? `\n\nThe director has tagged this run, so only these steps will run: `
      + `${tags.join(", ")}. Set "steps" to exactly that list. Fill in every other `
      + `block anyway — a later run may use it.`
    : "";

  const answer = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${chosen}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key },
      timeoutMs,
      body: {
        systemInstruction: { parts: [{ text: SYSTEM + routing }] },
        contents: [{ role: "user", parts: [{ text: stripTags(prompt) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(STEP_PLAN_SCHEMA),
          temperature: 0.2,
          maxOutputTokens: 16000,
        },
      },
    },
  );

  if (!answer.ok) {
    const detail = answer.data?.error?.message ?? answer.text?.slice(0, 300);
    throw new StepError(`the planner refused (${answer.status}): ${detail}`);
  }
  const candidate = answer.data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) {
    throw new StepError(`the planner returned nothing (${candidate?.finishReason ?? "no reason given"})`);
  }

  const plan = coerce(parseJson(text));
  const { steps, warnings } = resolveSteps({ tags, proposed: plan.steps, hasMedia });
  plan.steps = steps;
  plan.notes = [...(plan.notes ?? []), ...warnings];
  return plan;
}

/** Relative luminance, the WCAG way — used only to decide dark text or light. */
function luminance(hex) {
  const channel = (pair) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Keep the asked-for text colour when it is legible on the fill, and otherwise
 *  swap in near-black or white — whichever the fill can actually carry. */
export function readable(textColor, fillColor) {
  if (textColor && contrast(textColor, fillColor) >= 4.5) return textColor;
  return luminance(fillColor) > 0.4 ? "#141422" : "#FFFFFF";
}

/**
 * Pin the values the downstream services would otherwise coerce in silence.
 *
 * ui-snap replaces a bad `source` and truncates a long fact without saying so, and
 * a plausible-but-wrong screenshot is worse than an error. Same for the button,
 * where an unknown animation renders as nothing.
 */
export function coerce(raw) {
  const plan = { ...raw };
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const clamp = (value, max) => String(value ?? "").slice(0, max);

  plan.ugc = { screen_in_shot: true, ...(plan.ugc ?? {}) };
  plan.ugc.script = String(plan.ugc.script ?? "").trim();
  plan.ugc.action = String(plan.ugc.action ?? "").trim();

  const ui = plan.uiSnap ?? {};
  plan.uiSnap = {
    kind: "memory",
    mockup: false,
    companionName: clamp(ui.companionName || "Echo", 40),
    screen: pick(ui.screen, ["home", "arc", "person"], "home"),
    openArcId: ui.openArcId ?? null,
    openPersonId: null,
    people: [],
    owner: {
      name: clamp(ui.owner?.name ?? "", 80),
      relation: clamp(ui.owner?.relation ?? "", 80),
      metOn: clamp(ui.owner?.metOn ?? "", 40),
      chips: (ui.owner?.chips ?? []).slice(0, 12).map((c) => clamp(c, 60)),
      paragraphs: (ui.owner?.paragraphs ?? []).slice(0, 12).map((p) => clamp(p, 600)),
    },
    arcs: (ui.arcs ?? []).slice(0, 24).map((arc, i) => ({
      id: clamp(arc.id || `arc${i}`, 64),
      title: clamp(arc.title, 80),
      blurb: clamp(arc.blurb, 600),
      facts: (arc.facts ?? []).slice(0, 200).map((fact, j) => ({
        id: clamp(fact.id || `f${j}`, 64),
        text: clamp(fact.text, 500),
        date: clamp(fact.date, 40),
        source: pick(fact.source, FACT_SOURCES, "conversation"),
      })),
    })),
  };
  // An openArcId pointing at nothing opens the home screen instead, silently.
  const arcIds = new Set(plan.uiSnap.arcs.map((a) => a.id));
  if (plan.uiSnap.screen === "arc" && !arcIds.has(plan.uiSnap.openArcId)) {
    plan.uiSnap.openArcId = plan.uiSnap.arcs[0]?.id ?? null;
    if (!plan.uiSnap.openArcId) plan.uiSnap.screen = "home";
  }

  plan.captions = { preset: pick(plan.captions?.preset, CAPTION_PRESETS, "hormozi") };

  const props = plan.button?.props ?? {};
  const hex = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(value ?? "") ? value : fallback);
  const fillColor = hex(props.fillColor, "#FFFFFF");
  plan.button = {
    leadSeconds: Number(plan.button?.leadSeconds) > 0 ? Number(plan.button.leadSeconds) : 5,
    props: {
      label: clamp(props.label || "Try Replika now", 60),
      fillColor,
      // A model asked for a white button will happily hand back white text too, and
      // an invisible CTA is the kind of thing nobody notices until the export.
      textColor: readable(hex(props.textColor, ""), fillColor),
      positionY: Number.isFinite(props.positionY) ? Math.min(1, Math.max(0, props.positionY)) : 0.82,
      animation: pick(props.animation, ANIMATIONS, "slideUp"),
      easing: pick(props.easing, EASINGS, "soft"),
    },
  };

  plan.packshot = {
    media: "storage/media/logo-with-wordmark.mp4",
    backdrop: /^#[0-9a-f]{6}$/i.test(plan.packshot?.backdrop ?? "") ? plan.packshot.backdrop : "#0B0B0F",
  };

  plan.title = clamp(plan.title || "untitled", 60);
  plan.notes = (plan.notes ?? []).map((n) => String(n));
  return plan;
}
