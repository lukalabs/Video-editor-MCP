import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import type { Clip, Track } from "@openreel/core";
import { useUIStore } from "../../../stores/ui-store";
import { useProjectStore } from "../../../stores/project-store";
import { ClipComponent } from "./ClipComponent";

/**
 * Dragging a multi-selection must move every selected clip by the same delta.
 *
 * The regression this guards: the companion delta used to be measured against the
 * `clip.startTime` prop, which the drag itself updates every frame. From the second
 * frame on, the delta collapsed to a single frame's movement and the companions were
 * left behind — the dragged clip moved alone.
 */

function makeClip(overrides: Partial<Clip>): Clip {
  return {
    id: "clip-1",
    mediaId: "media-1",
    trackId: "t1",
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

function makeTrack(id: string, clips: Clip[], locked = false): Track {
  return {
    id,
    type: "video",
    name: id,
    clips,
    transitions: [],
    locked,
    hidden: false,
    muted: false,
    solo: false,
  } as unknown as Track;
}

const PPS = 10;

function setup(options: { lockT2?: boolean } = {}) {
  const dragged = makeClip({ id: "clip-1", trackId: "t1", startTime: 0 });
  const companion = makeClip({ id: "clip-2", trackId: "t2", startTime: 10 });
  const tracks = [
    makeTrack("t1", [dragged]),
    makeTrack("t2", [companion], options.lockT2),
    makeTrack("t3", []),
  ];

  useUIStore.setState({
    selectedItems: [
      { id: "clip-1", type: "clip" },
      { id: "clip-2", type: "clip" },
    ],
    // Snapping off: these tests are about the delta applied to a selection, and a
    // companion clip sitting within the snap threshold would otherwise pull the
    // dragged clip onto its edge. Snapping has its own tests.
    snapSettings: {
      enabled: false,
      snapToGrid: false,
      snapToClips: false,
      snapToPlayhead: false,
      snapToMarkers: false,
      gridSize: 1,
      snapThreshold: 10,
    },
  } as never);
  useProjectStore.setState({
    beginHistoryGroup: vi.fn(),
    endHistoryGroup: vi.fn(),
  } as never);

  const onMoveClip = vi.fn();
  const timelineRef = { current: document.createElement("div") };
  // Stable across renders, exactly as Timeline.tsx passes them (both are
  // useCallback with no deps there). Fresh spies per render would re-run the drag
  // effect for reasons that have nothing to do with the code under test.
  const onSelect = vi.fn();
  const onSnapIndicator = vi.fn();
  const trackHeights = new Map([["t1", 48], ["t2", 48], ["t3", 48]]);

  /**
   * Mirrors what the real editor does during a drag: every committed move writes to
   * the store, which re-renders this component with a NEW `clip.startTime` and a new
   * `allTracks` identity. Without that feedback the component would see a frozen
   * prop and the stale-baseline bug this file guards could not reproduce.
   */
  const Harness: React.FC = () => {
    const [startTime, setStartTime] = React.useState(0);
    const liveClip = React.useMemo(
      () => makeClip({ id: "clip-1", trackId: "t1", startTime }),
      [startTime],
    );
    const liveTracks = React.useMemo(
      () => [
        makeTrack("t1", [liveClip]),
        makeTrack("t2", [companion], options.lockT2),
        makeTrack("t3", []),
      ],
      [liveClip],
    );

    const handleMove = React.useCallback(
      (clipId: string, newStartTime: number, targetTrackId?: string) => {
        onMoveClip(clipId, newStartTime, targetTrackId);
        if (clipId === "clip-1") setStartTime(newStartTime);
      },
      [],
    );

    return (
      <ClipComponent
        clip={liveClip}
        track={liveTracks[0]}
        allTracks={liveTracks}
        pixelsPerSecond={PPS}
        isSelected
        trackHeights={trackHeights}
        timelineRef={timelineRef}
        onSelect={onSelect}
        onMoveClip={handleMove}
        onSnapIndicator={onSnapIndicator}
      />
    );
  };

  const view = render(<Harness />);

  const clipEl = view.container.querySelector("[data-clip-id]") ?? view.container.firstElementChild;
  return { view, tracks, dragged, onMoveClip, clipEl: clipEl as Element };
}

/** One drag: press, cross the threshold, move, release. */
async function drag(
  clipEl: Element,
  moves: Array<{ x: number; y: number }>,
) {
  fireEvent.mouseDown(clipEl, { button: 0, clientX: 0, clientY: 0 });
  // Past DRAG_THRESHOLD so the pending drag promotes to a real one.
  fireEvent.mouseMove(window, { clientX: 20, clientY: 0 });
  for (const move of moves) {
    fireEvent.mouseMove(window, { clientX: move.x, clientY: move.y });
    // Moves are committed once per animation frame, and each commit re-renders the
    // component with a new startTime. Letting the frame run between moves is what
    // makes this a real multi-frame drag rather than one batched jump.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  }
  await act(async () => {
    fireEvent.mouseUp(window);
  });
}

function movesFor(onMoveClip: ReturnType<typeof vi.fn>, clipId: string) {
  return onMoveClip.mock.calls.filter(([id]) => id === clipId);
}

describe("ClipComponent multi-clip drag", () => {
  afterEach(() => {
    cleanup();
    useUIStore.setState({ selectedItems: [] } as never);
  });

  it("moves the companion clip by the same delta as the dragged clip", async () => {
    const { clipEl, onMoveClip } = setup();

    // 50px right at 10px/s = +5s.
    await drag(clipEl, [{ x: 50, y: 0 }]);

    const primary = movesFor(onMoveClip, "clip-1").at(-1);
    const companion = movesFor(onMoveClip, "clip-2").at(-1);

    expect(primary?.[1]).toBeCloseTo(5, 5);
    // Companion started at 10s and must land 5s later, keeping the 10s gap.
    expect(companion?.[1]).toBeCloseTo(15, 5);
  });

  it("keeps the delta measured from the drag start across many move events", async () => {
    const { clipEl, onMoveClip } = setup();

    // Several frames of movement: the companion must track the total delta, not
    // the distance travelled since the previous frame.
    await drag(clipEl, [
      { x: 20, y: 0 },
      { x: 40, y: 0 },
      { x: 60, y: 0 },
      { x: 80, y: 0 },
    ]);

    const primary = movesFor(onMoveClip, "clip-1").at(-1);
    const companion = movesFor(onMoveClip, "clip-2").at(-1);

    expect(primary?.[1]).toBeCloseTo(8, 5);
    expect(companion?.[1]).toBeCloseTo(18, 5);
    // The gap between the two clips is exactly what it was before the drag.
    expect((companion?.[1] as number) - (primary?.[1] as number)).toBeCloseTo(10, 5);
  });

  it("opens and closes exactly one history group for the whole drag", async () => {
    const { clipEl } = setup();
    const begin = useProjectStore.getState().beginHistoryGroup as ReturnType<typeof vi.fn>;
    const end = useProjectStore.getState().endHistoryGroup as ReturnType<typeof vi.fn>;

    await drag(clipEl, [
      { x: 20, y: 0 },
      { x: 40, y: 0 },
      { x: 60, y: 0 },
    ]);

    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledWith("Move clips");
    expect(end).toHaveBeenCalledTimes(1);
  });
});
