import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@openreel/core";
import { ServerSyncManager } from "./server-sync";
import { ProjectConflictError } from "./server-storage";

/**
 * Server sync is now the primary save path, so the behaviours that matter are the ones
 * that decide whether work survives: does it coalesce instead of hammering, does it stop
 * rather than clobber on a conflict, and does it keep trying when the network is down.
 */

const saveServerProject = vi.hoisted(() => vi.fn());
const loadServerProject = vi.hoisted(() => vi.fn());

vi.mock("./server-storage", async () => {
  const actual = await vi.importActual<typeof import("./server-storage")>(
    "./server-storage",
  );
  return {
    ...actual,
    saveServerProject: (...args: unknown[]) => saveServerProject(...args),
    loadServerProject: (...args: unknown[]) => loadServerProject(...args),
  };
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: { items: [] },
    ...overrides,
  } as unknown as Project;
}

/** A project that differs from the opened baseline. */
function edited(n: number): Project {
  return project({ name: `Test ${n}` });
}

describe("ServerSyncManager", () => {
  let sync: ServerSyncManager;

  beforeEach(() => {
    vi.useFakeTimers();
    saveServerProject.mockReset();
    loadServerProject.mockReset();
    saveServerProject.mockResolvedValue({ updatedAt: 1000 });
    sync = new ServerSyncManager();
  });

  afterEach(() => {
    sync.stop();
    vi.useRealTimers();
  });

  it("does not create a project server-side until it is actually edited", async () => {
    const pristine = project();
    sync.beginProject(pristine, null);

    sync.markDirty(pristine);
    await vi.advanceTimersByTimeAsync(10000);

    expect(saveServerProject).not.toHaveBeenCalled();
    expect(sync.getState().status).toBe("idle");
  });

  it("saves once the project differs from what was opened", async () => {
    sync.beginProject(project(), null);

    sync.markDirty(edited(1));
    await vi.advanceTimersByTimeAsync(2000);

    expect(saveServerProject).toHaveBeenCalledTimes(1);
    expect(sync.getState().status).toBe("saved");
    expect(sync.getState().expectedUpdatedAt).toBe(1000);
  });

  it("coalesces a burst of edits into a single write", async () => {
    sync.beginProject(project(), 500);

    for (let i = 1; i <= 8; i++) {
      sync.markDirty(edited(i));
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(5000);

    // Eight edits 200ms apart are one quiet period, so one write - not eight.
    expect(saveServerProject).toHaveBeenCalledTimes(1);
  });

  it("keeps at least the throttle interval between writes while editing continues", async () => {
    sync.beginProject(project(), 500);

    sync.markDirty(edited(1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveServerProject).toHaveBeenCalledTimes(1);

    // An edit immediately after the first save must wait out the throttle, not fire at
    // the 2s debounce.
    sync.markDirty(edited(2));
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveServerProject).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3500);
    expect(saveServerProject).toHaveBeenCalledTimes(2);
  });

  it("skips a save when the content is identical to what the server already has", async () => {
    const same = edited(1);
    sync.beginProject(project(), 500);

    sync.markDirty(same);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveServerProject).toHaveBeenCalledTimes(1);

    sync.markDirty(same);
    await vi.advanceTimersByTimeAsync(10000);
    expect(saveServerProject).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately when asked, ignoring debounce and throttle", async () => {
    sync.beginProject(project(), 500);

    await sync.flushNow(edited(1));

    expect(saveServerProject).toHaveBeenCalledTimes(1);
  });

  it("stops and surfaces a real conflict instead of overwriting it", async () => {
    sync.beginProject(project(), 500);
    saveServerProject.mockRejectedValueOnce(new ProjectConflictError(900, 500));
    // Someone else's content: nothing like what we last sent.
    loadServerProject.mockResolvedValue({
      id: "p1",
      name: "Test",
      updatedAt: 900,
      project: project({ name: "Someone else's edit" }),
    });

    sync.markDirty(edited(1));
    await vi.advanceTimersByTimeAsync(2000);

    expect(sync.getState().status).toBe("conflict");
    expect(sync.getState().conflict).toEqual({
      serverUpdatedAt: 900,
      yourUpdatedAt: 500,
    });

    // And it must not keep trying while conflicted.
    const callsAtConflict = saveServerProject.mock.calls.length;
    sync.markDirty(edited(2));
    await vi.advanceTimersByTimeAsync(20000);
    expect(saveServerProject).toHaveBeenCalledTimes(callsAtConflict);
  });

  it("rebases silently when the conflicting copy is its own earlier write", async () => {
    const opened = project();
    sync.beginProject(opened, 500);
    // The server holds exactly what we opened - our own write landed, we just never saw
    // the response. Nobody else touched it, so this is safe to rebase onto.
    saveServerProject.mockRejectedValueOnce(new ProjectConflictError(900, 500));
    saveServerProject.mockResolvedValueOnce({ updatedAt: 1200 });
    loadServerProject.mockResolvedValue({
      id: "p1",
      name: "Test",
      updatedAt: 900,
      project: opened,
    });

    sync.markDirty(edited(1));
    await vi.advanceTimersByTimeAsync(2000);

    expect(sync.getState().status).toBe("saved");
    expect(sync.getState().conflict).toBeNull();
    expect(sync.getState().expectedUpdatedAt).toBe(1200);
  });

  it("retries a transient failure with a growing delay and recovers", async () => {
    sync.beginProject(project(), 500);
    saveServerProject.mockRejectedValueOnce(new Error("Failed to fetch"));

    sync.markDirty(edited(1));
    await vi.advanceTimersByTimeAsync(2000);

    expect(sync.getState().status).toBe("error");
    expect(sync.getState().error).toContain("Failed to fetch");

    await vi.advanceTimersByTimeAsync(2000);
    expect(saveServerProject).toHaveBeenCalledTimes(2);
    expect(sync.getState().status).toBe("saved");
  });

  it("backs the throttle off for a very large project", async () => {
    const big = project({
      name: "x".repeat(3 * 1024 * 1024),
    });
    sync.beginProject(project(), 500);

    sync.markDirty(big);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveServerProject).toHaveBeenCalledTimes(1);

    sync.markDirty(project({ name: "y".repeat(3 * 1024 * 1024) }));
    // Past the normal 5s throttle but short of the 30s large-project one.
    await vi.advanceTimersByTimeAsync(8000);
    expect(saveServerProject).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25000);
    expect(saveServerProject).toHaveBeenCalledTimes(2);
  });

  it("reports unsynced changes until the server has them", async () => {
    sync.beginProject(project(), 500);
    expect(sync.hasUnsyncedChanges()).toBe(false);

    sync.markDirty(edited(1));
    expect(sync.hasUnsyncedChanges()).toBe(true);
    expect(sync.pendingPayload()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2000);
    expect(sync.hasUnsyncedChanges()).toBe(false);
    expect(sync.pendingPayload()).toBeNull();
  });

  it("sends the concurrency baseline it was opened with", async () => {
    sync.beginProject(project(), 742);

    sync.markDirty(edited(1));
    await vi.advanceTimersByTimeAsync(2000);

    expect(saveServerProject).toHaveBeenCalledWith(expect.anything(), 742);
  });
});
