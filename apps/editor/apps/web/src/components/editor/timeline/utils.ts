import { Film, Volume2, Image, Type, Shapes, Layers } from "@/icons/lucide-compat";
import type { Track } from "@openreel/core";
import type {
  SnapPoint,
  SnapResult,
  SnapSettings,
  ClipStyle,
  TrackInfo,
} from "./types";

/** One clip of a multi-selection as captured when the drag began. */
export interface DraggedCompanion {
  readonly clipId: string;
  readonly startTime: number;
  readonly trackId: string;
}

export interface GroupTrackShift {
  /** How many tracks the whole selection moves. 0 means it stays put vertically. */
  readonly trackOffset: number;
  /** Track the dragged clip lands on. */
  readonly primaryTrackId: string;
  /** Destination track per companion clip id. */
  readonly destinations: ReadonlyMap<string, string>;
}

/**
 * Resolves where a dragged selection lands vertically.
 *
 * The selection moves as one rigid body: every clip shifts by the same number of
 * tracks, so the spacing between them survives the drag. The shift is all-or-nothing
 * - if any clip would land on a locked track or past either end of the track list,
 * the whole group keeps its tracks and only the horizontal move applies. A partial
 * shift would quietly stack clips that were on separate tracks onto one.
 */
export const resolveGroupTrackShift = (
  tracks: Track[],
  sourceTrackId: string,
  targetTrackId: string | undefined,
  companions: readonly DraggedCompanion[],
): GroupTrackShift => {
  const sourceIndex = tracks.findIndex((t) => t.id === sourceTrackId);
  const destIndex = targetTrackId
    ? tracks.findIndex((t) => t.id === targetTrackId)
    : sourceIndex;

  let trackOffset =
    sourceIndex >= 0 && destIndex >= 0 ? destIndex - sourceIndex : 0;

  if (trackOffset !== 0 && companions.length > 0) {
    const legal = companions.every((companion) => {
      const from = tracks.findIndex((t) => t.id === companion.trackId);
      if (from < 0) return false;
      const to = tracks[from + trackOffset];
      return Boolean(to) && !to.locked;
    });
    if (!legal) trackOffset = 0;
  }

  const destinations = new Map<string, string>();
  for (const companion of companions) {
    if (trackOffset === 0) {
      destinations.set(companion.clipId, companion.trackId);
      continue;
    }
    const from = tracks.findIndex((t) => t.id === companion.trackId);
    destinations.set(
      companion.clipId,
      tracks[from + trackOffset]?.id ?? companion.trackId,
    );
  }

  const primaryTrackId =
    trackOffset === 0
      ? companions.length > 0
        ? sourceTrackId
        : (targetTrackId ?? sourceTrackId)
      : (tracks[sourceIndex + trackOffset]?.id ?? sourceTrackId);

  return { trackOffset, primaryTrackId, destinations };
};

export const calculateSnap = (
  rawTime: number,
  clipId: string,
  tracks: Track[],
  playheadPosition: number,
  snapSettings: SnapSettings,
  pixelsPerSecond: number,
  clipDuration?: number,
): SnapResult => {
  if (!snapSettings.enabled) {
    return { time: rawTime, snapped: false };
  }

  const thresholdSeconds = snapSettings.snapThreshold / pixelsPerSecond;
  const snapPoints: SnapPoint[] = [];

  if (snapSettings.snapToClips) {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.id === clipId) continue;
        snapPoints.push({ time: clip.startTime, type: "clip-start" });
        snapPoints.push({
          time: clip.startTime + clip.duration,
          type: "clip-end",
        });
      }
    }
  }

  if (snapSettings.snapToPlayhead) {
    snapPoints.push({ time: playheadPosition, type: "playhead" });
  }

  if (snapSettings.snapToGrid) {
    const nearestGrid =
      Math.round(rawTime / snapSettings.gridSize) * snapSettings.gridSize;
    snapPoints.push({ time: nearestGrid, type: "grid" });
    if (clipDuration) {
      const endTime = rawTime + clipDuration;
      const nearestEndGrid =
        Math.round(endTime / snapSettings.gridSize) * snapSettings.gridSize;
      snapPoints.push({ time: nearestEndGrid, type: "grid" });
    }
  }

  const priorityOrder: Record<string, number> = {
    "clip-start": 0,
    "clip-end": 0,
    "playhead": 1,
    "grid": 2,
  };

  let closestPoint: SnapPoint | undefined;
  let closestDistance = Infinity;
  let closestPriority = Infinity;
  let snapFromEnd = false;

  for (const point of snapPoints) {
    const pointPriority = priorityOrder[point.type] ?? 2;

    const startDistance = Math.abs(point.time - rawTime);
    if (startDistance < thresholdSeconds) {
      const isBetter =
        pointPriority < closestPriority ||
        (pointPriority === closestPriority && startDistance < closestDistance);
      if (isBetter) {
        closestDistance = startDistance;
        closestPriority = pointPriority;
        closestPoint = point;
        snapFromEnd = false;
      }
    }

    if (clipDuration) {
      const clipEndTime = rawTime + clipDuration;
      const endDistance = Math.abs(point.time - clipEndTime);
      if (endDistance < thresholdSeconds) {
        const isBetter =
          pointPriority < closestPriority ||
          (pointPriority === closestPriority && endDistance < closestDistance);
        if (isBetter) {
          closestDistance = endDistance;
          closestPriority = pointPriority;
          closestPoint = point;
          snapFromEnd = true;
        }
      }
    }
  }

  if (closestPoint) {
    const snappedTime = snapFromEnd
      ? closestPoint.time - (clipDuration ?? 0)
      : closestPoint.time;
    return {
      time: Math.max(0, snappedTime),
      snapped: true,
      snapPoint: { ...closestPoint, time: closestPoint.time },
    };
  }

  return { time: rawTime, snapped: false };
};

export const generateWaveformPath = (
  waveformData: Float32Array | number[],
  width: number,
): string => {
  if (!waveformData || waveformData.length === 0) {
    return "M0,20 L100,20";
  }

  const samples = Array.from(waveformData);
  const step = Math.max(1, Math.floor(samples.length / width));
  const points: string[] = [];

  for (let i = 0; i < width; i++) {
    const sampleIndex = Math.min(i * step, samples.length - 1);
    const value = Math.abs(samples[sampleIndex] || 0);
    const y = 20 - value * 18;
    points.push(`${i === 0 ? "M" : "L"}${i},${y}`);
  }

  return points.join(" ");
};

interface ClipWaveformBarOptions {
  barCount: number;
  mediaDuration: number;
  inPoint: number;
  outPoint: number;
  reversed?: boolean;
}

/**
 * Samples the source-media waveform over the range represented by a timeline
 * clip. Each bar uses the highest peak in its source-time bucket so short
 * transients remain visible while genuinely silent buckets stay at zero.
 */
export const getClipWaveformBarAmplitudes = (
  waveformData: Float32Array | number[] | null | undefined,
  options: ClipWaveformBarOptions,
): number[] => {
  const barCount = Math.max(0, Math.floor(options.barCount));
  if (barCount === 0) return [];

  if (
    !waveformData ||
    waveformData.length === 0 ||
    !Number.isFinite(options.mediaDuration) ||
    options.mediaDuration <= 0
  ) {
    return Array.from({ length: barCount }, () => 0);
  }

  const mediaDuration = options.mediaDuration;
  const sourceStart = Math.max(0, Math.min(mediaDuration, options.inPoint));
  const sourceEnd = Math.max(
    sourceStart,
    Math.min(mediaDuration, options.outPoint),
  );
  const sourceDuration = sourceEnd - sourceStart;

  if (sourceDuration <= 0) {
    return Array.from({ length: barCount }, () => 0);
  }

  return Array.from({ length: barCount }, (_, barIndex) => {
    const displayIndex = options.reversed
      ? barCount - barIndex - 1
      : barIndex;
    const bucketStartTime =
      sourceStart + (displayIndex / barCount) * sourceDuration;
    const bucketEndTime =
      sourceStart + ((displayIndex + 1) / barCount) * sourceDuration;
    const startSample = Math.max(
      0,
      Math.min(
        waveformData.length - 1,
        Math.floor((bucketStartTime / mediaDuration) * waveformData.length),
      ),
    );
    const endSample = Math.max(
      startSample + 1,
      Math.min(
        waveformData.length,
        Math.ceil((bucketEndTime / mediaDuration) * waveformData.length),
      ),
    );

    let peak = 0;
    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex++) {
      const sample = Number(waveformData[sampleIndex]);
      if (Number.isFinite(sample)) {
        peak = Math.max(peak, Math.abs(sample));
      }
    }

    return Math.min(1, peak);
  });
};

export const formatTimecode = (
  timeInSeconds: number,
  frameRate: number = 30,
): string => {
  if (!isFinite(timeInSeconds) || isNaN(timeInSeconds) || timeInSeconds < 0) {
    return "00:00:00:00";
  }
  const hours = Math.floor(timeInSeconds / 3600);
  const minutes = Math.floor((timeInSeconds % 3600) / 60);
  const seconds = Math.floor(timeInSeconds % 60);
  const frames = Math.floor((timeInSeconds % 1) * frameRate);
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}:${frames
    .toString()
    .padStart(2, "0")}`;
};

export const getTrackInfo = (track: Track, index: number): TrackInfo => {
  if (track.mode === "standard") {
    return {
      label: `T${index + 1}`,
      icon: Layers,
      color: "bg-fg-muted",
      textColor: "text-fg-2",
      bgLight: "bg-fg-muted/10",
    };
  }
  switch (track.type) {
    case "video":
      return {
        label: `V${index + 1}`,
        icon: Film,
        color: "bg-primary",
        textColor: "text-primary",
        bgLight: "bg-primary/20",
      };
    case "audio":
      return {
        label: `A${index + 1}`,
        icon: Volume2,
        color: "bg-blue-500",
        textColor: "text-blue-400",
        bgLight: "bg-blue-500/20",
      };
    case "image":
      return {
        label: `I${index + 1}`,
        icon: Image,
        color: "bg-primary",
        textColor: "text-primary",
        bgLight: "bg-primary/20",
      };
    case "text":
      return {
        label: `T${index + 1}`,
        icon: Type,
        color: "bg-amber-500",
        textColor: "text-amber-400",
        bgLight: "bg-amber-500/20",
      };
    case "graphics":
      return {
        label: `G${index + 1}`,
        icon: Shapes,
        color: "bg-green-500",
        textColor: "text-green-400",
        bgLight: "bg-green-500/20",
      };
    default:
      return {
        label: `?${index + 1}`,
        icon: Layers,
        color: "bg-gray-500",
        textColor: "text-gray-400",
        bgLight: "bg-gray-500/20",
      };
  }
};

export const getClipStyle = (trackType: string): ClipStyle => {
  switch (trackType) {
    case "video":
      return {
        bg: "bg-[linear-gradient(160deg,#bcd3e8,#5d7a93)]",
        border: "border-transparent",
        text: "text-white",
        selectedText: "text-white",
      };
    case "audio":
      return {
        bg: "bg-[#e6f4ea]",
        border: "border-[#cfe8d6]",
        text: "text-[#4a7a55]",
        selectedText: "text-[#4a7a55]",
      };
    case "image":
      return {
        bg: "bg-[linear-gradient(160deg,#c3b1e8,#6a4aa0)]",
        border: "border-transparent",
        text: "text-white",
        selectedText: "text-white",
      };
    default:
      return {
        bg: "bg-[linear-gradient(160deg,#cdd4e0,#8a93a8)]",
        border: "border-transparent",
        text: "text-white",
        selectedText: "text-white",
      };
  }
};

/**
 * Snaps the edge being dragged to the nearest clip edge anywhere on the timeline.
 *
 * Trimming used to snap to nothing at all - the pixel delta went straight onto the
 * clip - so an edge could only be lined up with another clip by eye. `calculateSnap`
 * already gathers candidates from every track, so this is cross-track by
 * construction: the left edge of a clip on V1 will snap to the right edge of a clip
 * on A3, which is the alignment that actually matters when cutting to a beat or a
 * line of dialogue.
 *
 * Only clip edges and markers are considered. Grid and playhead snapping are left to
 * the move path: a trim is an alignment gesture against other material, and having
 * the edge jump to a grid line fights the frame-accurate nudge people expect.
 */
export const snapTrimEdge = (
  rawTime: number,
  clipId: string,
  tracks: Track[],
  snapSettings: SnapSettings,
  pixelsPerSecond: number,
): SnapResult => {
  if (!snapSettings.enabled || !snapSettings.snapToClips) {
    return { time: rawTime, snapped: false };
  }

  // No clipDuration: a trim moves one edge, so the opposite edge must not be
  // offered a snap of its own.
  return calculateSnap(
    rawTime,
    clipId,
    tracks,
    0,
    { ...snapSettings, snapToGrid: false, snapToPlayhead: false },
    pixelsPerSecond,
  );
};
