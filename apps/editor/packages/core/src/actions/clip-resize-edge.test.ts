import { describe, it, expect } from "vitest";
import { ActionExecutor } from "./action-executor";
import "./handlers";
import type { Project } from "../types/project";
import type { Action } from "../types/actions";
import type { Clip } from "../types/timeline";

/**
 * Dragging a clip edge goes through the action system. It previously wrote the store
 * directly with setState, which left no history entry at all — a trim could not be
 * undone.
 */

function makeProject(): Project {
  const clip = {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 2,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  } as unknown as Clip;

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
    timeline: {
      duration: 7,
      tracks: [
        {
          id: "t1",
          type: "video",
          name: "V1",
          clips: [clip],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

function theClip(project: Project): Clip {
  return project.timeline.tracks[0].clips[0];
}

function resize(params: Record<string, unknown>): Action {
  return {
    id: `resize-${Math.random()}`,
    type: "clip/resizeEdge",
    timestamp: Date.now(),
    params,
  } as unknown as Action;
}

describe("clip/resizeEdge", () => {
  it("moves the start and shortens the clip for a left-edge trim", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();

    const result = await executor.execute(
      resize({ clipId: "c1", startTime: 3, duration: 4 }),
      project,
    );

    expect(result.success).toBe(true);
    expect(theClip(project).startTime).toBe(3);
    expect(theClip(project).duration).toBe(4);
  });

  it("changes only the duration for a right-edge trim", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();

    await executor.execute(resize({ clipId: "c1", duration: 3 }), project);

    expect(theClip(project).startTime).toBe(2);
    expect(theClip(project).duration).toBe(3);
  });

  it("undoes a left-edge trim back to the original start and duration", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();

    await executor.execute(resize({ clipId: "c1", startTime: 3, duration: 4 }), project);
    const undone = await executor.undo(project);

    expect(undone.success).toBe(true);
    expect(theClip(project).startTime).toBe(2);
    expect(theClip(project).duration).toBe(5);
  });

  it("redoes the trim after an undo", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();

    await executor.execute(resize({ clipId: "c1", startTime: 3, duration: 4 }), project);
    await executor.undo(project);
    const redone = await executor.redo(project);

    expect(redone.success).toBe(true);
    expect(theClip(project).startTime).toBe(3);
    expect(theClip(project).duration).toBe(4);
  });

  it("restores the start even when the trim only sent a duration", async () => {
    // A right-edge drag sends no startTime. The inverse still has to restore every
    // field the action could have touched, or an undo leaves the clip half-moved.
    const project = makeProject();
    const executor = new ActionExecutor();

    await executor.execute(resize({ clipId: "c1", duration: 9 }), project);
    await executor.undo(project);

    expect(theClip(project).startTime).toBe(2);
    expect(theClip(project).duration).toBe(5);
  });

  it("restores keyframes shifted by the trim", async () => {
    const project = makeProject();
    (theClip(project) as unknown as { keyframes: unknown[] }).keyframes = [
      { id: "kf-exit-1", time: 5, property: "opacity", value: 0, easing: "linear" },
    ];
    const executor = new ActionExecutor();

    await executor.execute(
      resize({
        clipId: "c1",
        duration: 3,
        keyframes: [
          { id: "kf-exit-1", time: 3, property: "opacity", value: 0, easing: "linear" },
        ],
      }),
      project,
    );
    expect(theClip(project).keyframes[0].time).toBe(3);

    await executor.undo(project);
    expect(theClip(project).keyframes[0].time).toBe(5);
  });

  it("rejects a trim that would give the clip no duration", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();

    const result = await executor.execute(resize({ clipId: "c1", duration: 0 }), project);

    expect(result.success).toBe(false);
    expect(theClip(project).duration).toBe(5);
  });

  it("rejects a trim against a clip that does not exist", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();

    const result = await executor.execute(resize({ clipId: "nope", duration: 3 }), project);

    expect(result.success).toBe(false);
  });
});
