import { describe, it, expect } from "vitest";
import { ActionExecutor } from "./action-executor";
import type { Project } from "../types/project";
import type { Action } from "../types/actions";
import type { Clip } from "../types/timeline";

/**
 * `linkGroupId` marks clips split out of one source together (the video clip and the
 * audio `separateAudio` lifts off it), so an edit can follow across a genuine pair.
 * These cover the half that lives in core: a copy must never inherit the group, and
 * an explicitly passed group must survive onto the new clip.
 */

function baseClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
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
    ...overrides,
  } as unknown as Clip;
}

function projectWith(clips: Clip[]): Project {
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
      duration: 5,
      tracks: [
        {
          id: "t1",
          type: "video",
          name: "V1",
          clips,
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
    // clip/add validates that the media exists, so the library has to hold it.
    mediaLibrary: {
      items: [
        { id: "m1", name: "clip.mp4", type: "video", metadata: { duration: 5 } },
      ],
    },
  } as unknown as Project;
}

function allClips(project: Project): Clip[] {
  return project.timeline.tracks.flatMap((track) => track.clips);
}

describe("clip link groups", () => {
  it("does not copy the link group onto a clip cloned from a source clip", async () => {
    const linked = baseClip({ id: "c1", linkGroupId: "group-1" });
    const project = projectWith([linked]);
    const executor = new ActionExecutor();

    const action = {
      id: "a1",
      type: "clip/add",
      timestamp: Date.now(),
      params: {
        trackId: "t1",
        mediaId: "m1",
        startTime: 10,
        clipId: "c2",
        sourceClip: linked,
      },
    } as unknown as Action;

    const result = await executor.execute(action, project);
    expect(result.success).toBe(true);

    const copy = allClips(project).find((clip) => clip.id === "c2");
    expect(copy).toBeDefined();
    expect(copy?.linkGroupId).toBeUndefined();
    // The original keeps its link — only the copy is independent.
    expect(allClips(project).find((c) => c.id === "c1")?.linkGroupId).toBe("group-1");
  });

  it("keeps a clip unlinked when no group is passed", async () => {
    const project = projectWith([baseClip()]);
    const executor = new ActionExecutor();

    const action = {
      id: "a2",
      type: "clip/add",
      timestamp: Date.now(),
      params: { trackId: "t1", mediaId: "m1", startTime: 10, clipId: "c2" },
    } as unknown as Action;

    await executor.execute(action, project);
    expect(allClips(project).find((c) => c.id === "c2")?.linkGroupId).toBeUndefined();
  });

  it("carries an explicitly passed link group onto the new clip", async () => {
    const project = projectWith([baseClip({ linkGroupId: "group-1" })]);
    const executor = new ActionExecutor();

    const action = {
      id: "a3",
      type: "clip/add",
      timestamp: Date.now(),
      params: {
        trackId: "t1",
        mediaId: "m1",
        startTime: 10,
        clipId: "c2",
        linkGroupId: "group-1",
      },
    } as unknown as Action;

    await executor.execute(action, project);
    expect(allClips(project).find((c) => c.id === "c2")?.linkGroupId).toBe("group-1");
  });
});
