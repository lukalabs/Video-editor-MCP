import { describe, it, expect } from "vitest";
import type { Track } from "@openreel/core";
import { resolveGroupTrackShift, type DraggedCompanion } from "./utils";

/**
 * A dragged multi-selection moves vertically as one rigid body, or not at all.
 */

function track(id: string, locked = false): Track {
  return {
    id,
    type: "video",
    name: id,
    clips: [],
    transitions: [],
    locked,
    hidden: false,
    muted: false,
    solo: false,
  } as unknown as Track;
}

const TRACKS = [track("t1"), track("t2"), track("t3"), track("t4")];

function companion(clipId: string, trackId: string): DraggedCompanion {
  return { clipId, trackId, startTime: 0 };
}

describe("resolveGroupTrackShift", () => {
  it("shifts every clip by the same track offset, preserving the gaps between them", () => {
    const result = resolveGroupTrackShift(TRACKS, "t1", "t2", [
      companion("c2", "t2"),
      companion("c3", "t3"),
    ]);

    expect(result.trackOffset).toBe(1);
    expect(result.primaryTrackId).toBe("t2");
    // The one-track gap between the dragged clip and c3 survives the move.
    expect(result.destinations.get("c2")).toBe("t3");
    expect(result.destinations.get("c3")).toBe("t4");
  });

  it("keeps relative spacing across a two-track shift", () => {
    const result = resolveGroupTrackShift([...TRACKS, track("t5"), track("t6")], "t1", "t3", [
      companion("c2", "t2"),
      companion("c3", "t4"),
    ]);

    expect(result.trackOffset).toBe(2);
    expect(result.primaryTrackId).toBe("t3");
    expect(result.destinations.get("c2")).toBe("t4");
    expect(result.destinations.get("c3")).toBe("t6");
  });

  it("rejects the whole shift when one clip would land on a locked track", () => {
    const tracks = [track("t1"), track("t2"), track("t3", true), track("t4")];
    const result = resolveGroupTrackShift(tracks, "t1", "t2", [
      companion("c2", "t2"), // would land on locked t3
    ]);

    expect(result.trackOffset).toBe(0);
    expect(result.primaryTrackId).toBe("t1");
    expect(result.destinations.get("c2")).toBe("t2");
  });

  it("rejects the whole shift when one clip would fall off the end of the track list", () => {
    const result = resolveGroupTrackShift(TRACKS, "t1", "t2", [
      companion("c2", "t4"), // t4 is last: +1 is past the end
    ]);

    expect(result.trackOffset).toBe(0);
    expect(result.destinations.get("c2")).toBe("t4");
  });

  it("rejects a shift that would push a clip above the first track", () => {
    const result = resolveGroupTrackShift(TRACKS, "t3", "t2", [
      companion("c2", "t1"), // -1 from the first track
    ]);

    expect(result.trackOffset).toBe(0);
    expect(result.primaryTrackId).toBe("t3");
  });

  it("still moves a lone clip across tracks with no selection to hold back", () => {
    const result = resolveGroupTrackShift(TRACKS, "t1", "t3", []);

    expect(result.trackOffset).toBe(2);
    expect(result.primaryTrackId).toBe("t3");
  });

  it("stays on the current track when the drag never left it", () => {
    const result = resolveGroupTrackShift(TRACKS, "t2", undefined, [
      companion("c2", "t3"),
    ]);

    expect(result.trackOffset).toBe(0);
    expect(result.primaryTrackId).toBe("t2");
    expect(result.destinations.get("c2")).toBe("t3");
  });
});
