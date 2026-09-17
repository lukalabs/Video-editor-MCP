import { describe, it, expect } from "vitest";
import type { Clip, Track } from "@openreel/core";
import { calculateSnap, snapTrimEdge } from "./utils";
import type { SnapSettings } from "./types";
import { useUIStore } from "../../../stores/ui-store";

/**
 * Trimming a clip edge snaps to clip edges anywhere on the timeline — the point of
 * the feature is snapping ACROSS tracks, which is what lines a cut up with a beat or
 * a line of dialogue on another track. Before this, trims snapped to nothing at all.
 */

const PPS = 100; // 100px per second, so the 10px threshold is 0.1s.

function clip(id: string, startTime: number, duration: number): Clip {
  return { id, startTime, duration } as unknown as Clip;
}

function track(id: string, clips: Clip[]): Track {
  return {
    id,
    type: "video",
    name: id,
    clips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  } as unknown as Track;
}

const SETTINGS: SnapSettings = {
  enabled: true,
  snapToGrid: true,
  snapToClips: true,
  snapToPlayhead: true,
  gridSize: 1,
  snapThreshold: 10,
};

/** The clip being trimmed on V1, and an unrelated clip on A1 at 5s–8s. */
const TRACKS = [
  track("v1", [clip("trimming", 0, 4)]),
  track("a1", [clip("other-track", 5, 3)]),
];

describe("snapTrimEdge", () => {
  it("snaps a trimmed edge to a clip edge on a DIFFERENT track", () => {
    // Dragging the right edge to 4.97s, just short of the A1 clip's 5s start.
    const result = snapTrimEdge(4.97, "trimming", TRACKS, SETTINGS, PPS);

    expect(result.snapped).toBe(true);
    expect(result.time).toBeCloseTo(5, 5);
  });

  it("snaps to the far edge of a clip on another track", () => {
    // 8s is where the A1 clip ends.
    const result = snapTrimEdge(8.04, "trimming", TRACKS, SETTINGS, PPS);

    expect(result.snapped).toBe(true);
    expect(result.time).toBeCloseTo(8, 5);
  });

  it("leaves the edge alone beyond the snap threshold", () => {
    // 0.5s away from any edge, far outside 10px (0.1s at this zoom).
    const result = snapTrimEdge(4.5, "trimming", TRACKS, SETTINGS, PPS);

    expect(result.snapped).toBe(false);
    expect(result.time).toBeCloseTo(4.5, 5);
  });

  it("never snaps the clip being trimmed to its own edges", () => {
    // 4s is this clip's own end; the only candidate nearby is itself.
    const result = snapTrimEdge(4.0, "trimming", TRACKS, SETTINGS, PPS);

    expect(result.snapped).toBe(false);
  });

  it("does nothing when snapping is switched off entirely", () => {
    const result = snapTrimEdge(4.97, "trimming", TRACKS, { ...SETTINGS, enabled: false }, PPS);

    expect(result.snapped).toBe(false);
    expect(result.time).toBeCloseTo(4.97, 5);
  });

  it("does nothing when snapToClips is switched off", () => {
    const result = snapTrimEdge(4.97, "trimming", TRACKS, { ...SETTINGS, snapToClips: false }, PPS);

    expect(result.snapped).toBe(false);
    expect(result.time).toBeCloseTo(4.97, 5);
  });

  it("does not pull a trimmed edge onto the grid", () => {
    // 3.02s is within the threshold of the 3s grid line but far from any clip edge.
    // A trim is an alignment gesture against other material; grid snapping here
    // would fight a frame-accurate nudge.
    const result = snapTrimEdge(3.02, "trimming", TRACKS, SETTINGS, PPS);

    expect(result.snapped).toBe(false);
    expect(result.time).toBeCloseTo(3.02, 5);
  });

  it("respects a threshold expressed in pixels, so zoom changes what snaps", () => {
    // At 10px/s the same 10px threshold spans a whole second.
    const zoomedOut = snapTrimEdge(4.5, "trimming", TRACKS, SETTINGS, 10);
    expect(zoomedOut.snapped).toBe(true);
    expect(zoomedOut.time).toBeCloseTo(5, 5);
  });
});

describe("snap threshold default", () => {
  it("is 10px, not the old grabby 40", () => {
    expect(useUIStore.getState().snapSettings.snapThreshold).toBe(10);
  });
});

describe("move snapping regression", () => {
  it("still snaps a moved clip to an edge on another track", () => {
    const result = calculateSnap(4.97, "trimming", TRACKS, 0, SETTINGS, PPS, 4);

    expect(result.snapped).toBe(true);
    expect(result.time).toBeCloseTo(5, 5);
  });

  it("still snaps a moved clip by its trailing edge", () => {
    // A 4s clip dragged so its END lands near the 5s start of the A1 clip.
    const result = calculateSnap(1.02, "trimming", TRACKS, 0, SETTINGS, PPS, 4);

    expect(result.snapped).toBe(true);
    expect(result.time).toBeCloseTo(1, 5);
  });
});
