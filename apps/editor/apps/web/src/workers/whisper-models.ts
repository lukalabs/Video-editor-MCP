export type WhisperModelKey = "accurate" | "fast";

export interface WhisperModelDefinition {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly downloadSize: string;
  readonly description: string;
  /**
   * Whether the ONNX export can return per-word timestamps.
   *
   * Word timings are extracted from the decoder's cross-attentions, which only the
   * "_timestamped" builds are exported with. Asking a model without them for word
   * timestamps fails the whole transcription ("Model outputs must contain cross
   * attentions to extract timestamps"), so this is checked before requesting them
   * rather than discovered at runtime.
   */
  readonly supportsWordTimestamps: boolean;
}

export const WHISPER_MODELS: Record<WhisperModelKey, WhisperModelDefinition> = {
  accurate: {
    id: "onnx-community/whisper-large-v3-turbo_timestamped",
    label: "Accurate · Large V3 Turbo",
    shortLabel: "Large V3 Turbo",
    downloadSize: "About 760 MB",
    description: "Best local accuracy; WebGPU recommended",
    supportsWordTimestamps: true,
  },
  fast: {
    id: "onnx-community/whisper-tiny",
    label: "Fast · Whisper Tiny",
    shortLabel: "Whisper Tiny",
    downloadSize: "About 100 MB",
    description: "Fastest option for drafts and lower-memory devices",
    supportsWordTimestamps: false,
  },
};

export const DEFAULT_WHISPER_MODEL: WhisperModelKey = "accurate";

export function isWhisperModelKey(value: unknown): value is WhisperModelKey {
  return value === "accurate" || value === "fast";
}
