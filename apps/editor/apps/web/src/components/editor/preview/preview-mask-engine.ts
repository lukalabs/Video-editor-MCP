import { MaskEngine } from "@openreel/core";

/**
 * The preview's own mask engine, separate from the shared one in the engine store.
 *
 * Drawing a masked clip loads that clip's masks into the engine it is given (applyMask
 * reads keyframes from the engine and draws on its canvas), which replaces everything
 * else there. On the shared engine that meant it only ever held the clips under the
 * playhead - and since the Mask panel saved from that engine, adding a mask to one clip
 * deleted the masks on every other clip. A private instance keeps rendering exactly as it
 * was while leaving the shared engine alone. Export already works this way: VideoEngine
 * owns a private MaskEngine too.
 */
let previewMaskEngine: MaskEngine | null = null;

export function getPreviewMaskEngine(): Promise<MaskEngine> {
  previewMaskEngine ??= new MaskEngine({ width: 1920, height: 1080 });
  return Promise.resolve(previewMaskEngine);
}
