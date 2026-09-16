/**
 * `orchestrate start` — the whole thing behind one command and a question.
 *
 * Brings the three servers up if they are not already, then asks what you want to
 * make, over and over, until you say quit. Everything else in this tool is still
 * there and still scriptable; this is the shape for when you are working rather
 * than debugging.
 *
 * The one thing it will not do is spend without asking. "Fully automatic" is about
 * not clicking through five approval screens, not about a typo costing money — so
 * the render is one keystroke away, never zero.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { StepError } from "./lib.js";
import { startAll, stopAll } from "./servers.js";
import { runMake, runResume } from "./run.js";

const log = (line = "") => console.log(line);

const HELP = `
  Type what you want to make, in a sentence.

    a redhead woman in a sunny dorm room says [I kept telling myself I was fine],
    holding her phone with the Replika memory screen saying she broke up with her
    boyfriend. A "Try Replika now" button at the end, TikTok subtitles, packshot.

  Anything in @tags pins which steps run: @ui-snap @ugc-farm @captions @button @packshot

  Other things you can type:
    720p / 1080p / 480p   change the resolution for the next one
    clip <path>           edit a clip you already have, no AI render (free)
    clip                  on its own, go back to rendering new ones
    again                 re-run the last prompt
    help                  this
    quit                  stop asking (the servers keep running; "orch stop" ends them)
`;

/**
 * Lines in, one at a time, whether they are typed or piped.
 *
 * `rl.question` is the obvious way and it is wrong here. Piped input closes stdin
 * the moment the last line is written, and the close arrives while earlier lines
 * are still buffered — so racing close against the question drops them, and not
 * racing it hangs forever on Ctrl-D. Queueing the `line` events instead means
 * close only ends the session once there is genuinely nothing left to read.
 */
function lineReader(rl, out) {
  const queue = [];
  let waiting = null;
  let ended = false;

  const hand = (value) => {
    const resolve = waiting;
    waiting = null;
    resolve(value);
  };

  rl.on("line", (line) => (waiting ? hand(line.trim()) : queue.push(line.trim())));
  rl.on("close", () => {
    ended = true;
    if (waiting) hand(null);
  });

  /** @returns {Promise<string|null>} null once there is nothing more coming. */
  return (prompt) => {
    if (queue.length) {
      // Echo it, so a piped session reads like a typed one in the log.
      const line = queue.shift();
      out.write(`${prompt}${line}\n`);
      return Promise.resolve(line);
    }
    if (ended) return Promise.resolve(null);
    out.write(prompt);
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };
}

export async function runSession(flags) {
  log("starting what this needs\n");
  const { ok } = await startAll(log);
  if (!ok) {
    log("\nSomething did not come up. The log tail above says why.");
    return;
  }

  const rl = createInterface({ input: stdin });
  const ask = lineReader(rl, stdout);
  let resolution = flags.resolution;
  let media = flags.media ?? null;
  let last = "";

  log(`\nReady. Type a sentence, or "help". Rendering at ${resolution}.\n`);

  for (;;) {
    const line = await ask("make ▸ ");
    if (line === null) break;
    if (!line) continue;

    const word = line.toLowerCase();
    if (word === "quit" || word === "exit" || word === "q") break;
    if (word === "help" || word === "?") { log(HELP); continue; }
    if (["480p", "720p", "1080p"].includes(word)) {
      resolution = word;
      log(`  next render: ${resolution}\n`);
      continue;
    }
    if (word === "clip" || word.startsWith("clip ")) {
      // `clip` on its own puts it back to rendering, which otherwise there is no
      // way back to short of restarting.
      media = line.slice(4).trim() || null;
      log(media
        ? `  using ${media} — prompts now edit that instead of rendering one\n`
        : "  back to rendering a new clip with ugc-farm\n");
      continue;
    }
    const prompt = word === "again" ? last : line;
    if (!prompt) { log("  nothing to repeat yet.\n"); continue; }
    last = prompt;

    // Dry run first, always. It makes the screenshot and writes the real video
    // prompt, so what you are agreeing to pay for is on screen before you agree.
    let runId = null;
    try {
      log("");
      runId = await runMake(prompt, {
        ...flags, resolution, media,
        dryRun: !media, spend: false, serve: Boolean(media),
      });
    } catch (error) {
      log(`\n  stopped: ${error.message}`);
      if (error.hint) log(`          ${error.hint}`);
      log("");
      continue;
    }

    // With your own clip there is nothing to buy — it is already finished.
    if (media) { log(""); continue; }

    const go = await ask(`\nrender it for real at ${resolution}? [y/N] ▸ `);
    if (go?.toLowerCase() !== "y") {
      log(`\n  left as a dry run. When you want it:  orch resume ${runId} --spend\n`);
      continue;
    }
    try {
      await runResume(runId, { ...flags, resolution, media: null, spend: true, dryRun: false });
    } catch (error) {
      log(`\n  stopped: ${error.message}`);
      if (error.hint) log(`          ${error.hint}`);
      if (error instanceof StepError && error.fatal) {
        log("          nothing was retried — read the hint before running it again.");
      }
    }
    log("");
  }

  rl.close();
  log("\nThe servers are still running. `orch stop` shuts them down.");
}

export function runStop() {
  log("stopping");
  stopAll(log);
}
