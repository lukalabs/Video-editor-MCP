import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SUBTITLE_STYLE_PRESETS,
  type TranscriptionSegment,
  type SubtitleWord,
} from "@openreel/core";
import {
  ToolcraftButton as Button,
  ToolcraftCard as Card,
  ToolcraftSelectControl as Selector,
  ToolcraftText as Text,
} from "@openreel/ui";
import {
  AlertCircle,
  Check,
  Download,
  Languages,
  Loader2,
  Sparkles,
} from "@/icons/lucide-compat";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { loadAudioBuffer } from "../../../utils/load-audio-buffer";
import { audioBufferToWhisperSamples } from "../../../utils/whisper-audio";
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODELS,
  isWhisperModelKey,
  type WhisperModelKey,
} from "../../../workers/whisper-models";

const CAPTION_STYLE_PRESETS = ["default", "modern", "bold", "cinematic", "minimal"] as const;
const WHISPER_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "hi", name: "Hindi" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "ru", name: "Russian" },
  { code: "tr", name: "Turkish" },
  { code: "pl", name: "Polish" },
  { code: "vi", name: "Vietnamese" },
] as const;

/**
 * A caption cue plus the real word timings behind it.
 *
 * Whisper is now asked for word-level timestamps, so a transcription comes back as a
 * flat run of words rather than sentence chunks. Cues are built here instead of being
 * split by proportional time later: with real timings the cue boundaries land on
 * actual word boundaries, and each cue can carry the words its animation needs.
 */
interface CaptionCue extends TranscriptionSegment {
  readonly words: SubtitleWord[];
}

/** Words whose text ends a sentence; a cue prefers to break after one. */
const SENTENCE_END = /[.!?…]["')\]]?$/u;

/**
 * Groups timed words into cues of at most `maxWords`, breaking early at sentence
 * ends so a cue does not straddle two sentences when it does not have to.
 */
function groupWordsIntoCues(
  words: readonly SubtitleWord[],
  maxWords: number,
): CaptionCue[] {
  const limit = Math.max(1, Math.floor(maxWords));
  const cues: CaptionCue[] = [];
  let current: SubtitleWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      text: current.map((word) => word.text).join(" "),
      startTime: current[0].startTime,
      endTime: current[current.length - 1].endTime,
      confidence: 1,
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    current.push(word);
    if (current.length >= limit || SENTENCE_END.test(word.text)) flush();
  }
  flush();

  return cues;
}

interface AutoCaptionPanelProps {
  clipId?: string;
  maxWordsPerLine?: number;
}

interface WorkerChunk {
  text: string;
  timestamp: [number | null, number | null];
}

type WorkerState = "idle" | "loading" | "ready";

export const AutoCaptionPanel: React.FC<AutoCaptionPanelProps> = ({
  clipId,
  maxWordsPerLine = 5,
}) => {
  const getClip = useProjectStore((state) => state.getClip);
  const getMediaItem = useProjectStore((state) => state.getMediaItem);
  const addSubtitle = useProjectStore((state) => state.addSubtitle);
  const workerRef = useRef<Worker | null>(null);
  const [workerState, setWorkerState] = useState<WorkerState>("idle");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [selectedStyle, setSelectedStyle] = useState<string>("default");
  const [selectedModel, setSelectedModel] = useState<WhisperModelKey>(
    DEFAULT_WHISPER_MODEL,
  );
  const [readyModels, setReadyModels] = useState<Set<WhisperModelKey>>(
    () => new Set(),
  );
  const [modelBackends, setModelBackends] = useState<
    Partial<Record<WhisperModelKey, "webgpu" | "wasm">>
  >({});
  const [segments, setSegments] = useState<CaptionCue[]>([]);
  const [error, setError] = useState<string | null>(null);

  const selectedItems = useUIStore((state) => state.selectedItems);
  const resolvedClipId =
    clipId ?? selectedItems.find((item) => item.type === "clip")?.id ?? "";
  const clip = getClip(resolvedClipId);
  const mediaItem = clip ? getMediaItem(clip.mediaId) : undefined;
  const canTranscribe = Boolean(
    clip && mediaItem && (mediaItem.type === "video" || mediaItem.type === "audio"),
  );

  useEffect(() => {
    const worker = new Worker(
      new URL("../../../workers/whisper-worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const runWorker = useCallback(
    (
      type: "load" | "transcribe",
      audio?: Float32Array,
    ): Promise<{ text?: string; chunks?: WorkerChunk[]; wordTimestamps?: boolean }> => {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error("Caption worker is not ready."));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const handleMessage = (event: MessageEvent<Record<string, unknown>>) => {
          if (event.data.requestId !== requestId) return;
          const messageType = event.data.type;
          if (messageType === "model-progress") {
            setWorkerState("loading");
            const rawProgress = Number(event.data.progress ?? 0);
            setProgress(rawProgress > 1 ? rawProgress / 100 : rawProgress);
            const file = String(event.data.file ?? "caption model").split("/").pop();
            setProgressMessage(`Downloading ${file || "caption model"}…`);
          } else if (messageType === "transcription-progress") {
            setWorkerState("ready");
            setProgress(Number(event.data.progress ?? 0));
            setProgressMessage("Transcribing selected clip locally…");
          } else if (messageType === "ready") {
            worker.removeEventListener("message", handleMessage);
            setWorkerState("ready");
            setReadyModels((current) => new Set(current).add(selectedModel));
            const backend = event.data.backend;
            if (backend === "webgpu" || backend === "wasm") {
              setModelBackends((current) => ({
                ...current,
                [selectedModel]: backend,
              }));
            }
            setProgress(1);
            setProgressMessage("Offline caption model is ready");
            resolve({});
          } else if (messageType === "result") {
            worker.removeEventListener("message", handleMessage);
            setWorkerState("ready");
            setReadyModels((current) => new Set(current).add(selectedModel));
            const backend = event.data.backend;
            if (backend === "webgpu" || backend === "wasm") {
              setModelBackends((current) => ({
                ...current,
                [selectedModel]: backend,
              }));
            }
            setProgress(1);
            resolve({
              text: String(event.data.text ?? ""),
              chunks: (event.data.chunks ?? []) as WorkerChunk[],
              wordTimestamps: Boolean(event.data.wordTimestamps),
            });
          } else if (messageType === "error") {
            worker.removeEventListener("message", handleMessage);
            reject(new Error(String(event.data.message ?? "Local transcription failed.")));
          }
        };
        worker.addEventListener("message", handleMessage);
        if (audio) {
          worker.postMessage(
            {
              requestId,
              type,
              audio,
              language: selectedLanguage,
              model: selectedModel,
            },
            [audio.buffer],
          );
        } else {
          worker.postMessage({
            requestId,
            type,
            language: selectedLanguage,
            model: selectedModel,
          });
        }
      });
    },
    [selectedLanguage, selectedModel],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      if (!isWhisperModelKey(value)) return;
      setSelectedModel(value);
      setSegments([]);
      setError(null);
      setProgress(readyModels.has(value) ? 1 : 0);
      setProgressMessage(readyModels.has(value) ? "Offline caption model is ready" : "");
      setWorkerState(readyModels.has(value) ? "ready" : "idle");
    },
    [readyModels],
  );

  const handlePrepareModel = useCallback(async () => {
    setError(null);
    setWorkerState("loading");
    setProgress(0);
    setProgressMessage("Preparing offline caption model…");
    try {
      await runWorker("load");
    } catch (reason) {
      setWorkerState("idle");
      setError(reason instanceof Error ? reason.message : "Model download failed.");
    }
  }, [runWorker]);

  const handleTranscribe = useCallback(async () => {
    if (!clip || !mediaItem) return;
    setError(null);
    setSegments([]);
    setIsTranscribing(true);
    setProgress(0);
    setProgressMessage("Extracting selected clip audio…");

    let audioContext: AudioContext | null = null;
    try {
      const sourceBlob =
        mediaItem.blob ??
        (mediaItem.fileHandle ? await mediaItem.fileHandle.getFile() : null);
      if (!sourceBlob) {
        throw new Error("Reconnect the source media before creating captions.");
      }
      audioContext = new AudioContext();
      const audioBuffer = await loadAudioBuffer(audioContext, sourceBlob, {
        audioTrackIndex: clip.audioTrackIndex,
        onProgress: (next) => {
          setProgress(next.progress * 0.18);
          setProgressMessage(next.message);
        },
      });
      if (!audioBuffer) throw new Error("The selected clip audio could not be decoded.");

      const sourceStart = Math.max(0, clip.inPoint ?? 0);
      const sourceEnd = Math.min(
        audioBuffer.duration,
        clip.outPoint > sourceStart
          ? clip.outPoint
          : sourceStart + clip.duration * Math.max(clip.speed ?? 1, 0.01),
      );
      const samples = audioBufferToWhisperSamples(audioBuffer, sourceStart, sourceEnd);
      setProgress(0.2);
      setProgressMessage(
        workerState === "ready"
          ? `Transcribing with ${WHISPER_MODELS[selectedModel].shortLabel}…`
          : `Downloading ${WHISPER_MODELS[selectedModel].shortLabel}, then transcribing…`,
      );
      const result = await runWorker("transcribe", samples);
      const sourceDuration = Math.max(0.1, sourceEnd - sourceStart);
      const playbackSpeed = Math.max(clip.speed ?? 1, 0.01);
      const clipEndTime = clip.startTime + clip.duration;
      // Source seconds to timeline seconds: the clip may start part-way into its
      // media and may be sped up, and a word's timestamp is in source time.
      const toTimelineTime = (sourceTime: number) =>
        Math.min(
          clipEndTime,
          clip.startTime +
            Math.min(Math.max(0, sourceTime), sourceDuration) / playbackSpeed,
        );

      const timedChunks = (result.chunks ?? [])
        .map((chunk) => {
          const start = Math.max(0, chunk.timestamp?.[0] ?? 0);
          // A trailing chunk sometimes comes back with an open end; give it a beat
          // rather than dropping it.
          const end = chunk.timestamp?.[1] ?? Math.min(sourceDuration, start + 0.3);
          return {
            text: chunk.text.trim(),
            startTime: toTimelineTime(start),
            endTime: toTimelineTime(Math.max(start + 0.05, end)),
          };
        })
        .filter((chunk) => chunk.text.length > 0 && chunk.endTime > chunk.startTime);

      // Only some models can report word timings (see whisper-models). When they
      // cannot, the chunks are sentence-ish segments and become cues as they are -
      // each one still animates, from timings derived off word length when it is
      // added to the timeline.
      let nextSegments: CaptionCue[] = result.wordTimestamps
        ? groupWordsIntoCues(timedChunks, maxWordsPerLine)
        : timedChunks.map((chunk) => ({ ...chunk, confidence: 1, words: [] }));

      // Nothing usable came back with timings but there is a transcript: keep the
      // text as one cue rather than losing the transcription entirely.
      if (nextSegments.length === 0 && result.text?.trim()) {
        nextSegments = [
          {
            text: result.text.trim(),
            startTime: clip.startTime,
            endTime: clipEndTime,
            confidence: 1,
            words: [],
          },
        ];
      }
      if (nextSegments.length === 0) {
        throw new Error("No speech was detected in the selected clip.");
      }
      setSegments(nextSegments);
      setProgressMessage("Captions are ready to add");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Local transcription failed.");
    } finally {
      await audioContext?.close().catch(() => undefined);
      setIsTranscribing(false);
    }
  }, [clip, mediaItem, runWorker, selectedModel, workerState]);

  const handleAddToTimeline = useCallback(async () => {
    if (!clip || segments.length === 0) return;
    const style = SUBTITLE_STYLE_PRESETS[selectedStyle] ?? SUBTITLE_STYLE_PRESETS.default;
    let addedCount = 0;
    for (const segment of segments) {
      // No re-splitting here any more: the cues were built from real word
      // boundaries during transcription, and splitting them again by proportional
      // time would throw away the timings that make the animation accurate.
      await addSubtitle(
        {
          id: `whisper-${crypto.randomUUID()}`,
          text: segment.text,
          startTime: segment.startTime,
          endTime: segment.endTime,
          style,
          ...(segment.words.length > 0 ? { words: segment.words } : {}),
        },
        {
          captionSource: "whisper",
          captionSourceClipId: clip.id,
          captionMaxWordsPerLine: maxWordsPerLine,
          captionWhisperModel: selectedModel,
        },
      );
      addedCount += 1;
    }
    setSegments([]);
    setProgressMessage(`${addedCount} single-line caption clips added`);
  }, [addSubtitle, clip, maxWordsPerLine, segments, selectedModel, selectedStyle]);

  const modelStatus = useMemo(() => {
    const model = WHISPER_MODELS[selectedModel];
    if (workerState === "ready") {
      const backend = modelBackends[selectedModel];
      return `Downloaded and cached${backend ? ` · ${backend === "webgpu" ? "GPU" : "CPU"}` : ""}`;
    }
    if (workerState === "loading") return progressMessage || "Downloading model…";
    return `${model.downloadSize} · ${model.description}`;
  }, [modelBackends, progressMessage, selectedModel, workerState]);

  return (
    <div className="w-full min-w-0 space-y-3">
      <Card variant="muted" padding={3} className="space-y-2 border border-primary/30 bg-primary/5">
        <div className="flex items-center justify-between gap-2">
          <Text type="supporting" color="secondary" className="text-[10px]">
            Model quality
          </Text>
          <Selector
            label="Local caption model"
            isLabelHidden
            size="sm"
            width={176}
            value={selectedModel}
            onChange={handleModelChange}
            isDisabled={workerState === "loading" || isTranscribing}
            options={(
              Object.entries(WHISPER_MODELS) as Array<
                [WhisperModelKey, (typeof WHISPER_MODELS)[WhisperModelKey]]
              >
            ).map(([value, model]) => ({
              label: model.label,
              value,
            }))}
          />
        </div>
        <div className="flex items-start gap-2">
          {workerState === "ready" ? (
            <Check size={15} className="mt-0.5 text-primary" aria-hidden />
          ) : (
            <Download size={15} className="mt-0.5 text-primary" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <Text type="supporting" weight="bold" className="block text-[11px] text-fg">
              {WHISPER_MODELS[selectedModel].shortLabel}
            </Text>
            <Text type="supporting" color="secondary" className="block text-[9px]">
              {modelStatus}
            </Text>
          </div>
        </div>
        {workerState === "loading" && (
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-2">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.max(3, Math.min(100, progress * 100))}%` }}
            />
          </div>
        )}
        {workerState === "idle" && (
          <Button
            label={`Download ${WHISPER_MODELS[selectedModel].shortLabel}`}
            icon={<Download size={13} aria-hidden />}
            variant="secondary"
            size="sm"
            onClick={handlePrepareModel}
            className="w-full justify-center"
          />
        )}
        <Text type="supporting" color="secondary" className="block text-[9px] leading-relaxed">
          Stored in this browser after the first download. Media never leaves your device.
        </Text>
      </Card>

      <Card variant="muted" padding={3} className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Languages size={14} className="text-fg-2" aria-hidden />
            <Text type="supporting" color="secondary" className="text-[10px]">Language</Text>
          </div>
          <Selector
            label="Caption language"
            isLabelHidden
            size="sm"
            width={132}
            value={selectedLanguage}
            onChange={setSelectedLanguage}
            isDisabled={isTranscribing}
            options={WHISPER_LANGUAGES.map((language) => ({
              label: language.name,
              value: language.code,
            }))}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Text type="supporting" color="secondary" className="text-[10px]">Caption style</Text>
          <Selector
            label="Caption style"
            isLabelHidden
            size="sm"
            width={132}
            value={selectedStyle}
            onChange={setSelectedStyle}
            isDisabled={isTranscribing}
            options={CAPTION_STYLE_PRESETS.map((preset) => ({
              label: preset[0].toUpperCase() + preset.slice(1),
              value: preset,
            }))}
          />
        </div>
      </Card>

      {error && (
        <Card variant="muted" padding={2} className="flex items-start gap-2 border border-red-500/30 bg-red-500/10">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" aria-hidden />
          <Text type="supporting" className="text-[10px] text-red-400">{error}</Text>
        </Card>
      )}

      {isTranscribing && (
        <Card variant="muted" padding={3} className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-primary" aria-hidden />
          <Text type="supporting" color="secondary" className="text-[10px]">
            {progressMessage}
          </Text>
        </Card>
      )}

      {segments.length > 0 && (
        <div className="space-y-2">
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {segments.map((segment, index) => (
              <Card key={`${segment.startTime}-${index}`} variant="muted" padding={2} className="text-[10px]">
                <span className="font-mono text-fg-muted">{segment.startTime.toFixed(1)}s</span>
                <span className="ml-2 text-fg">{segment.text}</span>
              </Card>
            ))}
          </div>
          <Button
            label={`Add ${segments.length} as Editable Text`}
            variant="primary"
            size="sm"
            onClick={handleAddToTimeline}
            className="w-full justify-center"
          />
        </div>
      )}

      <Button
        label={isTranscribing ? "Transcribing Locally…" : "Transcribe Selected Clip"}
        icon={
          isTranscribing ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Sparkles size={14} aria-hidden />
          )
        }
        variant="primary"
        size="md"
        onClick={handleTranscribe}
        isDisabled={!canTranscribe || isTranscribing}
        className="w-full justify-center"
      />
      {!canTranscribe && (
        <Text type="supporting" color="secondary" className="block text-center text-[9px]">
          Select a connected video or audio clip first.
        </Text>
      )}
    </div>
  );
};

export default AutoCaptionPanel;
