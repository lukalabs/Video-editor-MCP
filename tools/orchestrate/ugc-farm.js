/**
 * Driving ugc-farm without a person clicking through it.
 *
 * The service is built around five stages a human approves. Two of them satisfy
 * themselves here — uploading a screen replaces the avatar picker, and nobody is
 * cast on camera — so the run approves plan, avatar and prompt, and then renders.
 *
 * Everything that generates is queued and polled. Renders take minutes and cost
 * money, which shapes every decision in this file:
 *
 * - `onSubmit` fires the instant a render is accepted, before the first poll, so
 *   the caller can write down what it just paid for.
 * - a job that vanishes mid-render is never resubmitted. The service keeps its job
 *   list in memory, so a restart loses it while the task at the other end carries
 *   on — and the charge is recorded before the task even starts.
 * - `busy` adopts the running job rather than trying again.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { StepError, poll, request } from "./lib.js";

const PLAN_DEADLINE = 180000;
const PROMPT_DEADLINE = 600000;
/** The service waits on the model for 1800s before giving up, then downloads. */
const RENDER_DEADLINE = 2_100_000;
/** It polls the model every 15s itself, so asking faster only adds load. */
const RENDER_EVERY = 15000;

export class Farm {
  constructor({ baseUrl, password = "", log }) {
    this.baseUrl = baseUrl;
    this.headers = password ? { "X-App-Password": password } : {};
    this.log = log;
  }

  async call(method, path, body) {
    const answer = await request(`${this.baseUrl}${path}`, {
      method, body, headers: this.headers, timeoutMs: 60000,
    });
    if (answer.ok) return answer.data;
    const error = answer.data?.error;
    if (error) {
      throw new StepError(`ugc-farm: ${error.message}`, {
        code: error.code,
        hint: error.hint,
        fatal: error.code === "cap_reached",
      });
    }
    throw new StepError(`ugc-farm answered ${answer.status} for ${path}: ${answer.text?.slice(0, 200)}`);
  }

  project(id) {
    return this.call("GET", `/api/projects/${id}`);
  }

  /**
   * Wait for a queued step.
   *
   * A 404 means the service restarted and forgot the job, not that anything failed
   * — the project on disk is the truth. `onLost` decides what that means for this
   * particular step, because for a render it means "do not touch anything".
   */
  async await(jobId, { deadline, every = 3000, label, onLost }) {
    if (!jobId) return { status: "done", message: "replayed" };
    let dots = 0;
    return poll(async () => {
      const answer = await request(`${this.baseUrl}/api/jobs/${jobId}`, {
        headers: this.headers, timeoutMs: 30000,
      });
      if (answer.status === 404) return onLost ? onLost() : null;
      const job = answer.data ?? {};
      if (job.status === "error") {
        throw new StepError(`${label} failed: ${job.error || "no reason given"}`, { fatal: true });
      }
      return job.status === "done" ? job : null;
    }, {
      everyMs: every,
      deadlineMs: deadline,
      onTick: (seconds) => {
        dots += 1;
        if (dots % 4 === 0) this.log(`  ${label}… ${seconds}s`);
      },
    });
  }

  /* ----------------------------------------------------------- the stages */

  /** Create the project and wait for the scene plan. Returns its id. */
  async start({ script, action }) {
    if (!script.trim()) throw new StepError("there is no script to film");
    const started = await this.call("POST", "/api/projects", { script, action });
    const id = started.project_id;
    this.log(`  project ${id}`);
    await this.await(started.job_id, {
      deadline: PLAN_DEADLINE,
      label: "reading the scene",
      onLost: () => ({ status: "done", message: "the service restarted; reading the project instead" }),
    });
    return id;
  }

  /**
   * The screen in the shot, and the two approvals around it.
   *
   * `use_ui` has to be on: with it off the file is stored and then ignored by both
   * the reference list and the render payload — the video comes back with no phone
   * screen in it at all. And the upload clears the avatar approval on its way
   * through, so that approval has to come after, not before.
   */
  async setScene(id, { screenPng, describes, useCreator = false, durationSeconds = 0 }) {
    // Only the toggles. A PATCH carrying script or action clears every approval
    // and re-plans from the top.
    await this.call("PATCH", `/api/projects/${id}`, { use_ui: Boolean(screenPng), use_creator: useCreator });
    // The length has to be set before the prompt is written, not before the render:
    // the writer lays out its beats against it, and beats written for one length and
    // rendered at another is the mismatch this whole field exists to close.
    await this.call("POST", `/api/projects/${id}/plan`, {
      screen_in_shot: Boolean(screenPng),
      ...(durationSeconds ? { target_duration_s: durationSeconds } : {}),
      approve: true,
    });
    this.log(durationSeconds ? `  plan approved — ${durationSeconds}s asked for` : "  plan approved");

    if (!screenPng) return;
    const { readFileSync } = await import("node:fs");
    await this.call("POST", `/api/projects/${id}/screen`, {
      filename: "screen.png",
      data_base64: readFileSync(screenPng).toString("base64"),
      describes,
    });
    await this.call("POST", `/api/projects/${id}/approve`, { stage: "avatar" });
    this.log("  screen uploaded and approved");
  }

  /** Write the video prompt, approve it, and report how many parts came out. */
  async writePrompt(id) {
    const queued = await this.call("POST", `/api/projects/${id}/prompts`);
    await this.await(queued.job_id, {
      deadline: PROMPT_DEADLINE,
      label: "writing the prompt",
      onLost: () => ({ status: "done", message: "the service restarted; reading the project instead" }),
    });
    const project = await this.project(id);
    const parts = project.prompts ?? [];
    if (!parts.length) throw new StepError("ugc-farm wrote no prompt", { hint: `look at ${this.baseUrl}/p/${id}` });

    const broken = parts.filter((part) => part.errors);
    for (const part of parts) {
      this.log(`  part ${part.part}  ${part.duration_s}s, ${part.chars} chars, ${part.errors} error(s)`);
    }
    if (broken.length) {
      this.log(`  ! ${broken.length} part(s) have unresolved prompt errors — see ${this.baseUrl}/p/${id}`);
    }
    await this.call("POST", `/api/projects/${id}/approve`, { stage: "prompt" });
    return parts;
  }

  /** What a render would send, without sending it. Free. */
  dryRun(id, part, resolution) {
    return this.call("GET", `/api/projects/${id}/render-plan?part=${part}&resolution=${resolution}`);
  }

  limits() {
    return this.call("GET", "/api/limits");
  }

  /**
   * Render one part. This is the call that spends.
   *
   * @param {{onSubmit: (jobId: string) => void}} hooks `onSubmit` runs before the
   *   first poll, so the run is on disk before anything can be lost.
   */
  async render(id, part, { resolution, onSubmit }) {
    let queued;
    try {
      queued = await this.call("POST", `/api/projects/${id}/render`, { part, resolution });
    } catch (error) {
      if (error.code !== "busy") throw error;
      // Something is already running on this project. Adopting it is the only safe
      // move: submitting again would pay twice for the same seconds.
      const project = await this.project(id);
      if (!project.job) throw error;
      this.log(`  a job was already running (${project.job.kind}) — following it instead`);
      queued = { job_id: project.job.job_id };
    }
    onSubmit?.(queued.job_id);
    this.log(`  part ${part} submitted — this is the part that costs`);

    await this.await(queued.job_id, {
      deadline: RENDER_DEADLINE,
      every: RENDER_EVERY,
      label: `rendering part ${part}`,
      onLost: async () => {
        const project = await this.project(id);
        if ((project.renders ?? []).some((entry) => entry.part === part)) {
          this.log("  the service restarted, but the render had already landed");
          return { status: "done", message: "finished before the restart" };
        }
        throw new StepError(
          `ugc-farm forgot the job for part ${part} and the render is not on disk`,
          {
            code: "job_lost",
            fatal: true,
            hint: "this part is already paid for and may still be running. Look at "
              + `projects/${id}/video${part > 1 ? `-${part}` : ""}.json for its task id, `
              + "restart the service, then resume — do not render it again unless that file is empty",
          },
        );
      },
    });

    const project = await this.project(id);
    const record = (project.renders ?? []).find((entry) => entry.part === part);
    if (!record) throw new StepError(`part ${part} reported done but is not in the project`, { fatal: true });
    return record;
  }

  /** Approving a part is what unlocks the next one, which extends it. */
  accept(id, part) {
    return this.call("POST", `/api/projects/${id}/approve`, { stage: `render-${part}` });
  }

  /** Pull the finished file down. `media` is the path the project reports. */
  async download(media, destination) {
    const answer = await request(`${this.baseUrl}${media}`, {
      headers: this.headers, timeoutMs: 300000, raw: true,
    });
    if (!answer.ok) throw new StepError(`could not download ${media} (${answer.status})`);
    writeFileSync(destination, answer.bytes);
    return { path: destination, bytes: answer.bytes.length };
  }
}

/** The local name for a downloaded part, keeping whatever extension it came with. */
export function partFile(dir, part, media) {
  const extension = media.slice(media.lastIndexOf(".")) || ".mp4";
  return join(dir, `ugc-part-${part}${extension}`);
}
