/**
 * The plan, written out for a person to approve before anything runs.
 *
 * `orchestrate plan` already printed the JSON the planner returned, which answers
 * "what did it understand" but not "what is about to happen, in what order, and
 * what does it cost". Those are the questions somebody actually has with their
 * finger over the button, so they get their own rendering.
 *
 * Nothing here runs anything or reaches the network. It reads the plan and the
 * flags and formats them, so it is safe to call before the first paid step and
 * cheap enough to call again afterwards.
 */

/**
 * Output seconds are what the render bills for. Measured at 1080p and 720p and
 * written down in the README; 480p was never measured, so it is not guessed at
 * here — an invented number in a cost line is worse than an absent one.
 */
const TOKENS_PER_SECOND = { "1080p": 48700, "720p": 21600 };

/**
 * The beat rate ugc-farm divides the word count by when no length is asked for.
 * It lives in `ugc/scenario.py` and this is a copy, so it is only ever used to
 * say "about N seconds" — never to decide anything. When the two disagree the
 * service is right, which is why the estimate is labelled as one.
 */
const NOMINAL_BEAT_RATE = 1.6;

const round = (n) => Math.round(n * 100) / 100;
const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean).length;

/** `1,234` — thousands separated, because these numbers are read, not computed. */
const commas = (n) => Math.round(n).toLocaleString("en-US");

/** Wrap prose to a width, indented, so a long script stays readable in a terminal. */
function wrap(text, { indent = "    ", width = 74 } = {}) {
  const out = [];
  let line = "";
  for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(indent + line);
  return out;
}

/**
 * How long the clip will be, and how sure we are.
 *
 * An asked-for length is exact: it is sent to ugc-farm before the prompt is
 * written, so the beats are laid out against it. Without one the service works it
 * out from the word count, and the number here is this tool's estimate of that
 * arithmetic rather than the service's answer.
 */
export function clipSeconds(plan, flags) {
  const asked = flags.duration || Number(plan?.ugc?.durationSeconds) || 0;
  if (asked) return { seconds: asked, exact: true };
  const spoken = words(plan?.ugc?.script);
  if (!spoken) return { seconds: 0, exact: false };
  return { seconds: Math.max(4, Math.round(spoken / NOMINAL_BEAT_RATE)), exact: false };
}

/** What the render costs, in the units the bill is in. */
export function renderCost(seconds, resolution) {
  const rate = TOKENS_PER_SECOND[resolution];
  if (!rate || !seconds) return null;
  return { tokens: rate * seconds, rate };
}

/**
 * The whole brief, as lines.
 *
 * Steps are numbered as they will run, each one saying what it does, what it is
 * given, and whether it costs anything — so the paid one is impossible to miss
 * among the free ones.
 */
export function briefLines(plan, flags, { limits = null } = {}) {
  const steps = plan.steps ?? [];
  const runs = (name) => steps.includes(name);
  const { seconds, exact } = clipSeconds(plan, flags);
  const cost = renderCost(seconds, flags.resolution);
  const out = [];
  let n = 0;
  const step = (name, money) => `  ${++n}) ${name}${money ? `   ${money}` : "   free"}`;

  out.push("", `PLAN — ${plan.title || "untitled"}`, "");

  if (runs("ui-snap")) {
    out.push(step("ui-snap — the app screen"));
    out.push("     renders a Replika screen as a picture, to be held in the shot");
    out.push(...wrap(plan.ugc?.screen_describes, { indent: "     " }));
    out.push("");
  }

  if (runs("ugc-farm")) {
    out.push(step("ugc-farm — the footage", cost
      ? `PAID  ~${commas(cost.tokens)} tokens`
      : "PAID  cost unknown at this resolution"));
    out.push(`     ${flags.resolution}, ${exact ? `${seconds}s` : `about ${seconds}s`}`
      + `, 9:16${exact ? " (asked for)" : " (worked out from the script)"}`);
    out.push("     spoken words — these decide the render, so read them:");
    out.push(...wrap(plan.ugc?.script, { indent: "       " }));
    out.push("     the scene, as the camera sees it:");
    out.push(...wrap(plan.ugc?.action, { indent: "       " }));
    out.push("");
  }

  if (runs("captions")) {
    out.push(step("captions — subtitles"));
    out.push(`     transcribes what she actually said · preset ${plan.captions?.preset}`
      + ` · ${flags.captions}`);
    out.push("");
  }

  if (runs("button")) {
    const props = plan.button?.props ?? {};
    const lead = flags.buttonLead || plan.button?.leadSeconds;
    out.push(step("button — the CTA"));
    out.push(`     "${props.label}" · ${props.animation}/${props.easing}`
      + ` · ${lead}s on screen · ${Math.round((props.positionY ?? 0) * 100)}% down the frame`);
    // Size is the one the sentence is most likely to have asked for and the one
    // you cannot see until the render, so it goes in the plan rather than the log.
    if (props.width) {
      out.push(`     ${props.width}x${props.height}px, ${props.fontSize}px text`
        + ` — ${Math.round((props.width / 1080) * 100)}% of the frame's width`);
    }
    out.push("");
  }

  if (runs("packshot")) {
    out.push(step("packshot — the end card"));
    out.push(`     ${plan.packshot?.media}`);
    out.push("");
  }

  out.push("COST");
  out.push(cost
    ? `  one paid step: the render. ~${commas(cost.tokens)} tokens`
      + ` (${commas(cost.rate)}/sec x ${exact ? "" : "about "}${seconds}s)`
    : "  one paid step: the render. No measured rate for this resolution.");
  if (!exact && cost) {
    out.push("  the length is an estimate until ugc-farm writes the prompt, so the");
    out.push("  cost moves with it. Say a duration to fix it.");
  }
  out.push("  everything else runs on this machine and costs nothing.");
  if (limits?.note) out.push(`  cap: ${limits.note}`);
  out.push("");

  for (const note of plan.notes ?? []) out.push(...wrap(`note: ${note}`, { indent: "  " }));
  if ((plan.notes ?? []).length) out.push("");

  return out;
}

/** The beats and any complaints about them — the second look, once one exists. */
export function promptLines(parts) {
  const out = [];
  for (const part of parts ?? []) {
    const errors = part.errors ?? 0;
    out.push(`  part ${part.part}  ${part.duration_s}s`
      + (errors ? `  ${errors} error(s)` : "  no errors"));
    for (const beat of String(part.text ?? "").match(/^\[[^\]]+\].*$/gm) ?? []) {
      out.push(...wrap(beat.replace(/\s+/g, " "), { indent: "     ", width: 72 }));
    }
  }
  return out;
}

export const _test = { wrap, words, commas, NOMINAL_BEAT_RATE, TOKENS_PER_SECOND };
