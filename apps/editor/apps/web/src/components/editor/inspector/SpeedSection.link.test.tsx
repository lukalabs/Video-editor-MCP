import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Action, ActionResult, Clip, Project } from "@openreel/core";
import { getSpeedEngine } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { SpeedSection } from "./SpeedSection";

/**
 * Speed and reverse follow across a genuine detached A/V pair, and must NOT follow
 * across a duplicate. Before `linkGroupId` the fan-out matched any other clip sharing
 * a mediaId, which is exactly what a duplicate is — so reversing one copy reversed
 * the other.
 */

function clip(overrides: Partial<Clip>): Clip {
  return {
    id: "clip-1",
    mediaId: "media-1",
    trackId: "video-track",
    startTime: 0,
    duration: 4,
    inPoint: 0,
    outPoint: 4,
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    effects: [],
    audioEffects: [],
    volume: 1,
    keyframes: [],
    ...overrides,
  } as unknown as Clip;
}

function projectWith(videoClip: Clip, otherClip: Clip): Project {
  const project = createEmptyProject("Speed link");
  return {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 10,
      tracks: [
        {
          id: "video-track",
          type: "video",
          name: "Video",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [videoClip],
        },
        {
          id: "audio-track",
          type: "audio",
          name: "Audio",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [otherClip],
        },
      ],
    },
    mediaLibrary: {
      items: [
        {
          id: "media-1",
          name: "clip.mp4",
          type: "video",
          metadata: { duration: 4, channels: 2, width: 1920, height: 1080 },
        },
      ],
    },
  } as unknown as Project;
}

type ExecuteActionMock = ReturnType<typeof makeExecuteAction>;

function makeExecuteAction() {
  return vi.fn(
    async (_action: Action): Promise<ActionResult> => ({ success: true }),
  );
}

function reversedClipIds(executeAction: ExecuteActionMock): string[] {
  return executeAction.mock.calls
    .map(([action]) => action)
    .filter((action) => action.type === "clip/setReverse")
    .map((action) => action.params.clipId as string);
}

function speedClipIds(executeAction: ExecuteActionMock): string[] {
  return executeAction.mock.calls
    .map(([action]) => action)
    .filter((action) => action.type === "clip/setSpeed")
    .map((action) => action.params.clipId as string);
}

describe("SpeedSection link-group fan-out", () => {
  let executeAction: ExecuteActionMock;

  beforeEach(() => {
    // The speed engine is a module singleton keyed by clip id, so one test's
    // reverse would otherwise be the next test's starting state.
    getSpeedEngine().clear();
    executeAction = makeExecuteAction();
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ hasOpenProject: false });
  });

  function mount(videoClip: Clip, otherClip: Clip) {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(videoClip, otherClip),
      executeAction,
    });
    render(<SpeedSection clip={videoClip} />);
  }

  it("does not reverse a duplicate that merely shares the same media", () => {
    const original = clip({ id: "clip-1" });
    const duplicate = clip({ id: "clip-2", trackId: "audio-track", startTime: 5 });
    mount(original, duplicate);

    fireEvent.click(screen.getByRole("button", { name: /reverse clip/i }));

    expect(reversedClipIds(executeAction)).toEqual(["clip-1"]);
  });

  it("reverses the linked audio clip of a genuine detached pair", () => {
    const video = clip({ id: "clip-1", linkGroupId: "pair-1" });
    const detachedAudio = clip({
      id: "clip-2",
      trackId: "audio-track",
      linkGroupId: "pair-1",
    });
    mount(video, detachedAudio);

    fireEvent.click(screen.getByRole("button", { name: /reverse clip/i }));

    expect(reversedClipIds(executeAction)).toEqual(["clip-1", "clip-2"]);
  });

  it("does not change the speed of a duplicate sharing the same media", () => {
    const original = clip({ id: "clip-1" });
    const duplicate = clip({ id: "clip-2", trackId: "audio-track", startTime: 5 });
    mount(original, duplicate);

    fireEvent.click(screen.getByRole("button", { name: /set speed to 2×/i }));

    expect(speedClipIds(executeAction)).toEqual(["clip-1"]);
  });

  it("changes the speed of the linked audio clip of a detached pair", () => {
    const video = clip({ id: "clip-1", linkGroupId: "pair-1" });
    const detachedAudio = clip({
      id: "clip-2",
      trackId: "audio-track",
      linkGroupId: "pair-1",
    });
    mount(video, detachedAudio);

    fireEvent.click(screen.getByRole("button", { name: /set speed to 2×/i }));

    expect(speedClipIds(executeAction)).toEqual(["clip-1", "clip-2"]);
  });

  it("leaves the linked clip alone when 'apply speed to audio' is switched off", () => {
    const video = clip({ id: "clip-1", linkGroupId: "pair-1" });
    const detachedAudio = clip({
      id: "clip-2",
      trackId: "audio-track",
      linkGroupId: "pair-1",
    });
    mount(video, detachedAudio);

    fireEvent.click(screen.getByLabelText("Apply speed to audio"));
    fireEvent.click(screen.getByRole("button", { name: /reverse clip/i }));

    expect(reversedClipIds(executeAction)).toEqual(["clip-1"]);
  });
});
