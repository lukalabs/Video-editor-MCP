/**
 * What the adapter does when a render goes wrong.
 *
 * These are the branches that decide whether you pay twice, and they are hard to
 * trigger on purpose — the service has to die at exactly the wrong moment. So the
 * service is faked: a real HTTP server on a random port, handing back the exact
 * bodies ugc-farm would. The adapter is the real one, over a real socket. Nothing
 * here reaches a model or spends anything.
 *
 * Every test counts POST /render calls, because "did not resubmit" is the whole
 * point, and an assertion about behaviour is worth more than one about a message.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { Farm } from "../ugc-farm.js";

const RENDER = "POST /api/projects/P-1/render";

/**
 * Run `body` against a stand-in ugc-farm, and always shut it down afterwards.
 *
 * The finally is load-bearing: without it a subject that throws where it should
 * not leaks the listening socket, and `node --test` waits on the open handle
 * instead of reporting — so the first real regression would look like a hang
 * rather than a failure. (It did, while these tests were being written.)
 *
 * `routes` maps "METHOD /path" to a response, or to a function returning one.
 */
async function withFarm(routes, body) {
  const calls = [];
  const server = createServer((request, response) => {
    const key = `${request.method} ${request.url.split("?")[0]}`;
    calls.push(key);
    const route = routes[key];
    const answer = typeof route === "function" ? route() : route;
    if (!answer) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "not_found", message: `no ${key}`, hint: "" } }));
      return;
    }
    response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });

  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address();
  try {
    await body({
      calls,
      farm: new Farm({ baseUrl: `http://127.0.0.1:${port}`, log: () => {} }),
      renders: () => calls.filter((call) => call === RENDER).length,
    });
  } finally {
    await new Promise((closed) => server.close(closed));
  }
}

const accepted = { status: 202, body: { job_id: "j1" } };
const jobDone = { status: 200, body: { status: "done" } };
const jobGone = { status: 404, body: { error: { code: "not_found", message: "gone", hint: "" } } };
const landed = (part = 1) => ({
  status: 200,
  body: { id: "P-1", renders: [{ part, media: `/media/P-1/video.mp4`, elapsed_s: 90 }] },
});

test("the service forgets a running render: stop, do not pay again", async () => {
  await withFarm({
    [RENDER]: accepted,
    // The job registry lives in memory, so a restart answers 404 for a job that
    // may still be running at the model — and is already charged.
    "GET /api/jobs/j1": jobGone,
    // …and the project has no render for that part, so it did not land.
    "GET /api/projects/P-1": { status: 200, body: { id: "P-1", renders: [] } },
  }, async (fake) => {
    await assert.rejects(
      () => fake.farm.render("P-1", 1, { resolution: "720p" }),
      (error) => {
        assert.equal(error.code, "job_lost");
        assert.equal(error.fatal, true, "must stop the run rather than carry on");
        assert.match(error.hint, /already paid for/);
        assert.match(error.hint, /video\.json/, "must name the file holding the task id");
        assert.match(error.hint, /do not render it again/);
        return true;
      },
    );
    assert.equal(fake.renders(), 1, "one render submitted, none retried");
  });
});

test("the service forgets a render that had already landed: take it and move on", async () => {
  await withFarm({
    [RENDER]: accepted,
    "GET /api/jobs/j1": jobGone,
    "GET /api/projects/P-1": landed(),
  }, async (fake) => {
    const record = await fake.farm.render("P-1", 1, { resolution: "720p" });
    assert.equal(record.part, 1);
    assert.equal(record.media, "/media/P-1/video.mp4");
    assert.equal(fake.renders(), 1, "the finished render was claimed, not repeated");
  });
});

test("a job is already running: follow it rather than submit a second", async () => {
  let polled = 0;
  await withFarm({
    [RENDER]: {
      status: 409,
      body: { error: { code: "busy", message: "a job is already running", hint: "poll it" } },
    },
    "GET /api/projects/P-1": () => (polled === 0
      ? { status: 200, body: { id: "P-1", job: { job_id: "existing", kind: "rendering part 1", status: "running" }, renders: [] } }
      : landed()),
    "GET /api/jobs/existing": () => {
      polled += 1;
      return jobDone;
    },
  }, async (fake) => {
    const record = await fake.farm.render("P-1", 1, { resolution: "720p" });
    assert.equal(record.part, 1);
    assert.ok(fake.calls.includes("GET /api/jobs/existing"), "it followed the running job");
    assert.equal(fake.renders(), 1, "the 409 was not retried into a second paid render");
  });
});

test("busy with no job to adopt is an error, not a blind retry", async () => {
  await withFarm({
    [RENDER]: {
      status: 409,
      body: { error: { code: "busy", message: "a job is already running", hint: "poll it" } },
    },
    "GET /api/projects/P-1": { status: 200, body: { id: "P-1", job: null, renders: [] } },
  }, async (fake) => {
    await assert.rejects(
      () => fake.farm.render("P-1", 1, { resolution: "720p" }),
      (error) => error.code === "busy",
    );
    assert.equal(fake.renders(), 1, "it did not submit again hoping for better luck");
  });
});

test("the daily cap stops the run and says so", async () => {
  await withFarm({
    [RENDER]: {
      status: 429,
      body: {
        error: {
          code: "cap_reached",
          message: "2 of 2 renders used today",
          hint: "The daily render cap is set by RENDER_DAILY_LIMIT.",
        },
      },
    },
  }, async (fake) => {
    await assert.rejects(
      () => fake.farm.render("P-1", 1, { resolution: "720p" }),
      (error) => {
        assert.equal(error.code, "cap_reached");
        assert.equal(error.fatal, true, "a cap is not something to retry into");
        assert.match(error.message, /2 of 2/);
        return true;
      },
    );
  });
});

test("a render that failed at the model is fatal, not retried", async () => {
  await withFarm({
    [RENDER]: accepted,
    "GET /api/jobs/j1": {
      status: 200,
      body: { status: "error", error: "RuntimeError: content_policy_violation" },
    },
  }, async (fake) => {
    await assert.rejects(
      () => fake.farm.render("P-1", 1, { resolution: "720p" }),
      (error) => {
        assert.equal(error.fatal, true);
        assert.match(error.message, /content_policy_violation/);
        return true;
      },
    );
    assert.equal(fake.renders(), 1, "a failed render is charged — retrying would charge again");
  });
});

test("the run is written down before the first poll, not after", async () => {
  const order = [];
  await withFarm({
    [RENDER]: accepted,
    "GET /api/jobs/j1": () => {
      order.push("polled");
      return jobDone;
    },
    "GET /api/projects/P-1": landed(),
  }, async (fake) => {
    await fake.farm.render("P-1", 1, {
      resolution: "720p",
      onSubmit: (jobId) => {
        assert.equal(jobId, "j1");
        order.push("saved");
      },
    });
    // If this order ever flips, a crash in between loses the only record of a
    // render that has already been paid for.
    assert.deepEqual(order, ["saved", "polled"]);
  });
});

test("the resolution actually reaches the service", async () => {
  let sent = null;
  await withFarm({
    [RENDER]: accepted,
    "GET /api/jobs/j1": jobDone,
    "GET /api/projects/P-1": landed(),
  }, async (fake) => {
    // Read the body off the wire rather than trusting the call site.
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (String(url).endsWith("/render")) sent = JSON.parse(init.body);
      return original(url, init);
    };
    try {
      await fake.farm.render("P-1", 1, { resolution: "1080p" });
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(sent, { part: 1, resolution: "1080p" });
  });
});

test("an asked-for duration reaches the service before the prompt is written", async () => {
  const bodies = {};
  await withFarm({
    "PATCH /api/projects/P-1": { ok: true },
    "POST /api/projects/P-1/plan": { ok: true },
  }, async (fake) => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const path = String(url).replace(/^.*\/api/, "/api");
      if (init?.body) bodies[path] = JSON.parse(init.body);
      return original(url, init);
    };
    try {
      await fake.farm.setScene("P-1", { screenPng: "", describes: "", durationSeconds: 8 });
    } finally {
      globalThis.fetch = original;
    }
    // On the plan call, which happens before the prompt is written — not on the
    // render, where it would arrive too late to shape the beats.
    assert.equal(bodies["/api/projects/P-1/plan"].target_duration_s, 8);
  });
});

test("no duration asked for means the field is not sent at all", async () => {
  const bodies = {};
  await withFarm({
    "PATCH /api/projects/P-1": { ok: true },
    "POST /api/projects/P-1/plan": { ok: true },
  }, async (fake) => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const path = String(url).replace(/^.*\/api/, "/api");
      if (init?.body) bodies[path] = JSON.parse(init.body);
      return original(url, init);
    };
    try {
      await fake.farm.setScene("P-1", { screenPng: "", describes: "" });
    } finally {
      globalThis.fetch = original;
    }
    // Absent, rather than zero: the service reads a zero as "no length asked for"
    // too, but only because it is spelled the same way by accident.
    assert.ok(!("target_duration_s" in bodies["/api/projects/P-1/plan"]));
  });
});
