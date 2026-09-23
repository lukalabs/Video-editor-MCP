/**
 * The shared mask engine must mirror the OPEN project's masks - always, immediately.
 *
 * The Mask panel builds its saves from that engine, so any moment where the engine holds
 * something other than the open project's masks is a moment where a click writes the
 * wrong masks into storage. Two such moments existed:
 *
 *   - Opening a project loaded nothing into the engine. It only filled when the preview
 *     happened to draw a masked clip, about half a second later, and a mask action in
 *     that window replaced the project's masks.
 *   - Opening a project with no masks left the previous project's in place, and the next
 *     mask action wrote them into the new project.
 *
 * The assertions run synchronously after loadProject, with no await in between: "loaded
 * eventually" is exactly the behaviour that lost data.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Mask, MaskEngine, Project } from "@openreel/core";

import { useEngineStore } from "./engine-store";
import { useProjectStore } from "./project-store";
import { createEmptyProject } from "./project/project-helpers";
import { createProjectStoreHelpers } from "./project/store-helpers";

function mask(id: string, clipId: string): Mask {
  return {
    id,
    clipId,
    type: "drawn",
    path: {
      closed: true,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.5, y: 0.9 },
      ],
    },
    feathering: 0,
    inverted: false,
    expansion: 0,
    opacity: 1,
    keyframes: [],
  };
}

function projectWithMasks(name: string, masks: Mask[] | undefined): Project {
  const project = createEmptyProject(name);
  if (masks === undefined) {
    // Exactly what project-kit writes: no masks field at all.
    const { masks: _omitted, ...rest } = project as Project & { masks?: Mask[] };
    return rest as Project;
  }
  return { ...project, masks };
}

describe("shared mask engine follows the open project", () => {
  let engine: MaskEngine;

  beforeEach(async () => {
    engine = await useEngineStore.getState().getMaskEngine();
    engine.loadMasks([]);
  });

  it("holds the project's masks as soon as loadProject returns", () => {
    useProjectStore
      .getState()
      .loadProject(projectWithMasks("Two masks", [mask("m1", "clip-a"), mask("m2", "clip-b")]));

    // No await: the store now shows this project, so the engine must already match it.
    expect(engine.getAllMasks().map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("empties when the next project has no masks field, instead of keeping the last one's", () => {
    useProjectStore.getState().loadProject(projectWithMasks("Masked", [mask("old", "clip-a")]));
    // Whatever route filled it - the load itself, or the preview drawing that clip - the
    // engine holds the previous project's mask when the next project opens. Set it
    // explicitly so the test cannot pass just because nothing ever loaded.
    engine.loadMasks([mask("old", "clip-a")]);
    useProjectStore.getState().loadProject(projectWithMasks("Made by project-kit", undefined));

    expect(engine.getAllMasks()).toEqual([]);
  });

  it("empties on an undo/redo resync of a project with no masks field", () => {
    engine.loadMasks([mask("stale", "clip-a")]);
    let current = projectWithMasks("No masks", undefined);
    const helpers = createProjectStoreHelpers(
      (partial) => {
        const next = typeof partial === "function" ? partial({ project: current } as never) : partial;
        if ((next as { project?: Project }).project) current = (next as { project: Project }).project;
      },
      () => ({ project: current }) as never,
    );

    helpers.syncOverlayEnginesFromProject();

    expect(engine.getAllMasks()).toEqual([]);
  });
});
