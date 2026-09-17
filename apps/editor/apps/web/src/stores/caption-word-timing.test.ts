import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./project-store";
import { useEngineStore } from "./engine-store";
import { createEmptyProject } from "./project/project-helpers";

/**
 * Every caption gets word timing when it is created, so every caption can animate
 * without the user doing anything extra. Real timestamps win when the caller has
 * them; otherwise the cue's duration is shared out across its words by length.
 */

function captionClips() {
  return (useEngineStore.getState().getTitleEngine()?.getAllTextClips() ?? []).filter(
    (clip) => clip.metadata?.captionSource !== undefined,
  );
}

describe("caption word timing on creation", () => {
  beforeEach(async () => {
    useEngineStore.getState().getTitleEngine()?.loadTextClips([]);
    useProjectStore.getState().loadProject(createEmptyProject("Captions"));
    useProjectStore.setState({ hasOpenProject: true });
  });

  it("derives proportional word timings for a caption with no real timestamps", async () => {
    await useProjectStore.getState().addSubtitle(
      { id: "s1", text: "hi there extraordinary", startTime: 2, endTime: 5 },
      { captionSource: "srt" },
    );

    const [clip] = captionClips();
    expect(clip).toBeDefined();
    expect(clip.words?.map((w) => w.text)).toEqual(["hi", "there", "extraordinary"]);

    // Clip-relative: the clip sits at 2s but its words start at 0.
    expect(clip.words![0].startTime).toBe(0);
    expect(clip.words!.at(-1)!.endTime).toBeCloseTo(3, 6);
    // Longer word, longer slice.
    const spans = clip.words!.map((w) => w.endTime - w.startTime);
    expect(spans[1]).toBeGreaterThan(spans[0]);
    expect(spans[2]).toBeGreaterThan(spans[1]);
  });

  it("defaults new captions to the word-highlight style", async () => {
    await useProjectStore.getState().addSubtitle(
      { id: "s1", text: "one two", startTime: 0, endTime: 2 },
      { captionSource: "srt" },
    );

    expect(captionClips()[0].animationStyle).toBe("word-highlight");
  });

  it("keeps real word timestamps when the caller supplies them, rebased onto the clip", async () => {
    await useProjectStore.getState().addSubtitle(
      {
        id: "s1",
        text: "real timing here",
        startTime: 10,
        endTime: 13,
        // Callers pass timeline-absolute times, as Whisper reports them.
        words: [
          { text: "real", startTime: 10, endTime: 10.4 },
          { text: "timing", startTime: 10.4, endTime: 12.2 },
          { text: "here", startTime: 12.2, endTime: 13 },
        ],
      },
      { captionSource: "whisper" },
    );

    const [clip] = captionClips();
    expect(clip.words?.map((w) => w.text)).toEqual(["real", "timing", "here"]);
    // Rebased by the clip's 10s start, not re-derived from word length: "timing"
    // keeps its real 1.8s span rather than the ~1.2s its length would earn.
    const spans = clip.words!.map((w) => [w.startTime, w.endTime]);
    expect(spans[0][0]).toBeCloseTo(0, 6);
    expect(spans[0][1]).toBeCloseTo(0.4, 6);
    expect(spans[1][0]).toBeCloseTo(0.4, 6);
    expect(spans[1][1]).toBeCloseTo(2.2, 6);
    expect(spans[2][0]).toBeCloseTo(2.2, 6);
    expect(spans[2][1]).toBeCloseTo(3, 6);
  });

  it("respects an explicitly requested animation style", async () => {
    await useProjectStore.getState().addSubtitle(
      { id: "s1", text: "one two", startTime: 0, endTime: 2, animationStyle: "karaoke" },
      { captionSource: "srt" },
    );

    expect(captionClips()[0].animationStyle).toBe("karaoke");
  });

  it("leaves a blank caption without words rather than inventing them", async () => {
    await useProjectStore.getState().addSubtitle(
      { id: "s1", text: "   ", startTime: 0, endTime: 2 },
      { captionSource: "srt" },
    );

    expect(captionClips()[0].words).toEqual([]);
  });
});
