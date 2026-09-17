import type { Project } from "@openreel/core";

import { serializeProjectForAutoSave } from "./auto-save";

/**
 * Client for render-service's server-side storage (Stage 8).
 *
 * The server is the source of truth for projects, media bytes and component metadata, so
 * a project opens on any browser. OpenReel's IndexedDB layer is kept as a local cache
 * and offline safety net rather than removed — see NOTES.md for why.
 *
 * There is no authentication: anything reachable here is readable and writable by
 * anyone on the network. Deliberate for this stage.
 */

const BASE =
  (import.meta.env.VITE_RENDER_SERVICE_URL as string | undefined) ?? "http://127.0.0.1:3001";

export interface ProjectSummary {
  id: string;
  name: string;
  /**
   * Free-text folder. The server reports DEFAULT_PROJECT_FOLDER for a project that has
   * never been filed, so this is always a string - the panel never has to handle null.
   */
  folder: string;
  createdAt: number;
  updatedAt: number;
}

/** What the server calls a project with no folder. */
export const DEFAULT_PROJECT_FOLDER = "Uncategorized";

export interface ComponentMetadataEntry {
  mediaId: string;
  componentId: string;
  props: Record<string, unknown>;
  background: string | null;
  renderedFileId: string | null;
  updatedAt: number;
}

/** Thrown when a save would overwrite a newer version on the server. */
export class ProjectConflictError extends Error {
  readonly serverUpdatedAt: number;
  readonly yourUpdatedAt: number;

  constructor(serverUpdatedAt: number, yourUpdatedAt: number) {
    super("The project changed on the server since you opened it");
    this.name = "ProjectConflictError";
    this.serverUpdatedAt = serverUpdatedAt;
    this.yourUpdatedAt = yourUpdatedAt;
  }
}

export interface UploadedMedia {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
}

async function asJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = `${response.status} ${body.error}`;
    } catch {
      // non-JSON error body
    }
    throw new Error(`${what} failed: ${detail}`);
  }
  return (await response.json()) as T;
}

export function mediaUrl(mediaId: string): string {
  return `${BASE}/media/${mediaId}`;
}

/* -------------------------------------------------------------- projects */

export async function listServerProjects(
  folder?: string,
): Promise<ProjectSummary[]> {
  const query = folder ? `?folder=${encodeURIComponent(folder)}` : "";
  const response = await fetch(`${BASE}/projects${query}`);
  const body = await asJson<{ projects: ProjectSummary[] }>(response, "Listing projects");
  return body.projects;
}

/** The distinct folders in use, for the picker. */
export async function listServerProjectFolders(): Promise<string[]> {
  const response = await fetch(`${BASE}/projects/folders`);
  const body = await asJson<{ folders: string[] }>(response, "Listing folders");
  return body.folders;
}

/**
 * Re-files a project, sending only the new folder.
 *
 * Uses the narrow `/projects/:id/folder` route rather than a full PUT: the project list
 * carries summaries, not project JSON, so re-filing a project that is not open would
 * otherwise mean fetching the whole blob to change one column.
 */
export async function setServerProjectFolder(
  projectId: string,
  folder: string,
): Promise<{ id: string; folder: string; updatedAt: number }> {
  const response = await fetch(
    `${BASE}/projects/${encodeURIComponent(projectId)}/folder`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder }),
    },
  );
  return asJson(response, "Moving project to a folder");
}

/**
 * Deletes a project from the server. Irreversible: there is no trash.
 *
 * The route also sweeps media that no surviving project references any more (and the
 * component metadata hanging off it), so the ids it removed come back here — the panel
 * reports the count so a delete that quietly took media with it is visible.
 */
export async function deleteServerProject(
  id: string,
): Promise<{ deleted: string; orphanedMediaRemoved: string[] }> {
  const response = await fetch(`${BASE}/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return asJson(response, "Deleting project");
}

export async function loadServerProject(
  id: string,
): Promise<{ id: string; name: string; project: Project; updatedAt: number }> {
  const response = await fetch(`${BASE}/projects/${encodeURIComponent(id)}`);
  return asJson(response, "Loading project");
}

/**
 * Upsert: the project's own id is the key, so saving twice updates in place.
 *
 * The payload is stripped of binary fields first. `JSON.stringify` turns a `Blob` into
 * `{}` — which is *truthy*, so a naive round-trip would leave every media item looking
 * like it already had its bytes and the loader would never fetch them. Reuses OpenReel's
 * own autosave serialiser, which drops `blob`, `fileHandle`, `waveformData` and
 * session-local `blob:` thumbnail URLs.
 */
/**
 * Writes the project to the server.
 *
 * `folder` is optional and only sent when given, because the route treats an absent folder
 * as "leave whatever is stored alone" — so an ordinary save from the editor cannot reset a
 * folder someone set, while a save made with the picker filled in can set one. Pass an empty
 * string to clear it back to the default.
 */
export async function saveServerProject(
  project: Project,
  expectedUpdatedAt?: number | null,
  folder?: string,
): Promise<{ updatedAt: number }> {
  const stripped = JSON.parse(serializeProjectForAutoSave(project)) as Project;
  const response = await fetch(`${BASE}/projects/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: project.name,
      project: stripped,
      // Omitted (or null) means "overwrite regardless", which is the old behaviour.
      ...(expectedUpdatedAt != null ? { expectedUpdatedAt } : {}),
      ...(folder !== undefined ? { folder } : {}),
    }),
  });

  if (response.status === 409) {
    const body = (await response.json()) as {
      serverUpdatedAt: number;
      yourUpdatedAt: number;
    };
    throw new ProjectConflictError(body.serverUpdatedAt, body.yourUpdatedAt);
  }

  return asJson(response, "Saving project");
}

/* ----------------------------------------------------------------- media */

/**
 * Uploads the bytes under the editor's own mediaId, so a project loaded on another
 * browser can resolve `clip.mediaId` straight to `/media/:id`.
 */
export async function uploadMedia(
  mediaId: string,
  file: Blob,
  filename: string,
): Promise<UploadedMedia> {
  const response = await fetch(`${BASE}/media`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-filename": filename,
      "x-media-id": mediaId,
      "x-mime-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  return asJson(response, "Uploading media");
}

export async function fetchServerMedia(mediaId: string): Promise<Blob | null> {
  const response = await fetch(mediaUrl(mediaId));
  if (!response.ok) return null;
  return response.blob();
}

/* ---------------------------------------------------- component metadata */

export async function putComponentMetadata(
  entry: Omit<ComponentMetadataEntry, "updatedAt">,
): Promise<void> {
  const response = await fetch(`${BASE}/component-metadata`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry),
  });
  await asJson(response, "Saving component metadata");
}

export async function listComponentMetadata(): Promise<ComponentMetadataEntry[]> {
  const response = await fetch(`${BASE}/component-metadata`);
  const body = await asJson<{ entries: ComponentMetadataEntry[] }>(
    response,
    "Listing component metadata",
  );
  return body.entries;
}

export async function isServerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
