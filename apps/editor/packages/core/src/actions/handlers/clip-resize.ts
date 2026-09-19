import type { Action, ValidationResult } from "../../types/actions";
import type { Project } from "../../types/project";
import { registerActionHandler } from "../registry";
import type { ActionHandler } from "../registry";
import type { Keyframe } from "../../types/timeline";
import { findClip, patchClip } from "./clip-helpers";

/**
 * Dragging a clip's edge on the timeline.
 *
 * Distinct from `clip/trim`, which moves the source in/out points and leaves the
 * clip where it is. Dragging the left edge also moves the clip's start, so the two
 * have to change together or the clip jumps; expressing that as one action is what
 * makes a trim a single undo step.
 *
 * The timeline used to write these fields straight into the store with `setState`,
 * which bypassed history entirely - a trim could not be undone at all.
 *
 * `keyframes` is passed in rather than recomputed here: exit keyframes are pinned to
 * the end of the clip and have to shift when the duration changes, but the "kf-exit-"
 * convention that identifies them belongs to the editor, not to core.
 */

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

interface ResizeParams {
  clipId?: string;
  startTime?: number;
  duration?: number;
  keyframes?: Keyframe[];
}

const clipResizeEdge: ActionHandler = {
  type: "clip/resizeEdge",

  validate(action: Action, project: Project): ValidationResult {
    const params = action.params as ResizeParams;
    const errors = [];

    if (typeof params.clipId !== "string" || !findClip(project, params.clipId)) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip not found: ${String(params.clipId)}`,
      });
    }
    if (params.startTime !== undefined && !isFiniteNumber(params.startTime)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "startTime must be a number",
      });
    } else if (params.startTime !== undefined && params.startTime < 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "startTime must not be negative",
      });
    }
    if (params.duration !== undefined && !isFiniteNumber(params.duration)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "duration must be a number",
      });
    } else if (params.duration !== undefined && params.duration <= 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "duration must be greater than zero",
      });
    }
    if (params.keyframes !== undefined && !Array.isArray(params.keyframes)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "keyframes must be an array",
      });
    }

    return { valid: errors.length === 0, errors };
  },

  apply(action: Action, project: Project): void {
    const params = action.params as ResizeParams;
    patchClip(project, params.clipId as string, {
      ...(params.startTime !== undefined ? { startTime: params.startTime } : {}),
      ...(params.duration !== undefined ? { duration: params.duration } : {}),
      ...(params.keyframes !== undefined ? { keyframes: params.keyframes } : {}),
    });
  },

  invert(action: Action, projectBefore: Project): Action | null {
    const params = action.params as ResizeParams;
    const prior = findClip(projectBefore, params.clipId as string);
    if (!prior) return null;

    // Every field this action can touch is restored, not just the ones it changed:
    // a right-edge drag sends no startTime, and the inverse still has to put the
    // clip back exactly as it was.
    return {
      type: "clip/resizeEdge",
      id: `inverse-${action.id}`,
      timestamp: Date.now(),
      params: {
        clipId: params.clipId,
        startTime: prior.startTime,
        duration: prior.duration,
        keyframes: prior.keyframes,
      },
    } as Action;
  },
};

registerActionHandler(clipResizeEdge);
