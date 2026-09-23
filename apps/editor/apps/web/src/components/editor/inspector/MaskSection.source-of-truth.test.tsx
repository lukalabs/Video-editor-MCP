/**
 * The Mask panel saves what the PROJECT holds, not what the shared engine happens to hold.
 *
 * The panel used to build every save from `maskEngine.getAllMasks()`. That engine is only
 * a render cache, and it was routinely stale: empty for half a second after a project
 * opened, or holding just the clips the preview had drawn. Each save then wrote that stale
 * list over the project's real masks - deleting masks nobody touched. These tests set the
 * engine up in exactly those stale states and check that nothing is lost.
 */
import "../../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MaskEngine, type Clip, type Mask, type Project } from "@openreel/core";

import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useEngineStore } from "../../../stores/engine-store";
import { useProjectStore } from "../../../stores/project-store";
import { MaskSection } from "./MaskSection";

const X = "clip-x";
const Y = "clip-y";

function clip(id: string, startTime: number): Clip {
  return {
    id,
    mediaId: "media",
    trackId: "track",
    startTime,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  };
}

function mask(id: string, clipId: string): Mask {
  return {
    id,
    clipId,
    type: "drawn",
    path: {
      closed: true,
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ],
    },
    feathering: 0,
    inverted: false,
    expansion: 0,
    opacity: 1,
    keyframes: [],
  };
}

/** X plays 0-5s, Y plays 5-10s: with the playhead on X, the preview never draws Y. */
function project(): Project {
  const empty = createEmptyProject("Two masked clips");
  return {
    ...empty,
    modifiedAt: 1,
    masks: [mask("mask-on-x", X), mask("mask-on-y", Y)],
    timeline: {
      ...empty.timeline,
      duration: 10,
      tracks: [
        {
          id: "track",
          type: "video",
          name: "Video",
          clips: [clip(X, 0), clip(Y, 5)],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
  };
}

const storedIds = () => (useProjectStore.getState().project.masks ?? []).map((m) => m.id);

describe("MaskSection saves from the project, not from a stale engine", () => {
  let engine: MaskEngine;
  let originalGetMaskEngine: ReturnType<typeof useEngineStore.getState>["getMaskEngine"];

  beforeEach(() => {
    engine = new MaskEngine({ width: 1920, height: 1080 });
    originalGetMaskEngine = useEngineStore.getState().getMaskEngine;
    useEngineStore.setState({ getMaskEngine: async () => engine });
    useProjectStore.setState({ hasOpenProject: true, project: project() });
  });

  afterEach(() => {
    cleanup();
    useEngineStore.setState({ getMaskEngine: originalGetMaskEngine });
    useProjectStore.setState({ hasOpenProject: false, project: createEmptyProject("Reset") });
  });

  it("keeps another clip's mask when the engine only holds the clip under the playhead", async () => {
    // What the preview used to leave behind after drawing clip X.
    engine.loadMasks([mask("mask-on-x", X)]);
    render(<MaskSection clipId={X} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rectangle" }));

    await waitFor(() => expect(storedIds()).toHaveLength(3));
    expect(storedIds()).toEqual(expect.arrayContaining(["mask-on-x", "mask-on-y"]));
  });

  it("keeps the clip's own masks when acting before the engine has loaded anything", async () => {
    // The window right after a project opens: the store has the masks, the engine none.
    render(<MaskSection clipId={X} />);

    // The panel shows the project's truth rather than the empty engine...
    expect(await screen.findByText("Masks (1)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rectangle" }));

    // ...and a save keeps both existing masks.
    await waitFor(() => expect(storedIds()).toHaveLength(3));
    expect(storedIds()).toEqual(expect.arrayContaining(["mask-on-x", "mask-on-y"]));
  });
});
