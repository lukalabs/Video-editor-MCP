/**
 * Drawing a masked clip in the preview must not change the shared mask engine.
 *
 * The renderer loads the clip it is drawing into whatever engine it is given, replacing
 * everything else there. When that was the shared engine the Mask panel saves from, the
 * engine only ever held the clips under the playhead, and adding a mask to one clip
 * deleted the masks on every other clip - reproduced with no timing involved at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mask } from "@openreel/core";

import { useEngineStore } from "../../../stores/engine-store";
import { drawFrameWithMasks } from "./masked-frame-renderer";
import { getPreviewMaskEngine } from "./preview-mask-engine";
import { DEFAULT_TRANSFORM } from "./types";

function mask(id: string, clipId: string): Mask {
  return {
    id,
    clipId,
    type: "drawn",
    path: { closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
    feathering: 0,
    inverted: false,
    expansion: 0,
    opacity: 1,
    keyframes: [],
  };
}

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;

describe("the preview's mask engine", () => {
  afterEach(async () => {
    (await useEngineStore.getState().getMaskEngine()).loadMasks([]);
  });

  it("is not the shared engine the Mask panel saves from", async () => {
    expect(await getPreviewMaskEngine()).not.toBe(await useEngineStore.getState().getMaskEngine());
  });

  it("leaves the shared engine's masks alone when the preview draws one clip", async () => {
    const shared = await useEngineStore.getState().getMaskEngine();
    shared.loadMasks([mask("on-x", "clip-x"), mask("on-y", "clip-y")]);

    const previewEngine = await getPreviewMaskEngine();
    // Only the drawing itself is stubbed; the renderer's own loadMasks call is real.
    vi.spyOn(previewEngine, "applyMask").mockResolvedValue({
      image: bitmap(),
      processingTime: 0,
      gpuAccelerated: false,
    });

    await drawFrameWithMasks(
      {
        ctx: { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
        frame: bitmap(),
        transform: DEFAULT_TRANSFORM,
        canvasWidth: 640,
        canvasHeight: 360,
        masks: [mask("on-x", "clip-x")],
        maskEngine: previewEngine,
        time: 0,
      },
      {
        drawFrame: vi.fn(),
        createCanvas: () =>
          ({ getContext: () => ({ drawImage: vi.fn() }) }) as unknown as OffscreenCanvas,
        createBitmap: async () => bitmap(),
      },
    );

    expect(shared.getAllMasks().map((m) => m.id).sort()).toEqual(["on-x", "on-y"]);
  });
});
