import React, { useCallback, useEffect, useState } from "react";

import { refreshRegistry } from "../../../services/component-library-clips";
import { saveMediaBlob } from "../../../services/media-storage";
import {
  deleteServerProject,
  fetchServerMedia,
  listServerProjects,
  loadServerProject,
  listServerProjectFolders,
  ProjectConflictError,
  saveServerProject,
  setServerProjectFolder,
  DEFAULT_PROJECT_FOLDER,
  type ProjectSummary,
} from "../../../services/server-storage";
import { FolderPicker } from "./FolderPicker";
import { toast } from "../../../stores/notification-store";
import { useProjectStore } from "../../../stores/project-store";

/**
 * Server-side project list (Stage 8).
 *
 * The server is the source of truth: saving writes the whole project JSON to
 * render-service, and opening fetches it back plus the media bytes, so a project opens on
 * a browser that has never seen it. OpenReel's IndexedDB autosave stays underneath as a
 * local safety net.
 *
 * No authentication: every project here is visible and writable to anyone who can reach
 * the service, and concurrent edits are last-save-wins.
 */
export const ServerProjectsPanel: React.FC = () => {
  const project = useProjectStore((state) => state.project);
  const loadProject = useProjectStore((state) => state.loadProject);
  const getFullProject = useProjectStore((state) => state.getFullProject);

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The concurrency baseline and any conflict now live in the store, not here: saving
   * happens automatically whether or not this panel is mounted, so a baseline held in
   * component state would be lost the moment the panel closed.
   */
  const serverSync = useProjectStore((state) => state.serverSync);
  const beginServerSync = useProjectStore((state) => state.beginServerSync);
  const noteServerSave = useProjectStore((state) => state.noteServerSave);
  const clearServerSyncConflict = useProjectStore(
    (state) => state.clearServerSyncConflict,
  );
  const knownUpdatedAt = serverSync.expectedUpdatedAt;
  const conflict = serverSync.conflict;
  /** "" means every folder. Filtering happens client-side: the list is already loaded. */
  const [folderFilter, setFolderFilter] = useState("");
  /**
   * Folders as the SERVER reports them, from GET /projects/folders — deliberately not the
   * `folders` list derived from the loaded projects below. The two agree today, but the
   * pickers should offer what the server knows, so a folder created by another client (or by
   * an agent over MCP) shows up on the next refresh without depending on this browser
   * having loaded a project from it.
   */
  const [serverFolders, setServerFolders] = useState<string[]>([]);
  /** The folder the next save files the project under. "" leaves it where it is. */
  const [saveFolder, setSaveFolder] = useState("");
  /** Which card has its re-file row open, and what has been typed into it. */
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveFolder, setMoveFolder] = useState("");
  /**
   * Which card has its delete confirmation open. Deleting is irreversible and sweeps the
   * project's media with it, so the button only ever arms the confirm row — the DELETE
   * fires from the second button, which names the project.
   */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // Both in one pass: the list drives the grouped display, the folder list drives the
      // pickers. Fetched together so a newly created folder cannot be offered by one and
      // missing from the other.
      const [list, folderNames] = await Promise.all([
        listServerProjects(),
        listServerProjectFolders(),
      ]);
      setProjects(list);
      setServerFolders(folderNames);
    } catch (err) {
      setProjects(null);
      setError(err instanceof Error ? err.message : "Could not reach the server");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Projects bucketed by folder, preserving the server's newest-first order within each
   * bucket. The default folder is pushed last so real folders read first; everything else
   * is alphabetical.
   */
  const grouped = React.useMemo(() => {
    const map = new Map<string, ProjectSummary[]>();
    for (const summary of projects ?? []) {
      const key = summary.folder || DEFAULT_PROJECT_FOLDER;
      const bucket = map.get(key);
      if (bucket) bucket.push(summary);
      else map.set(key, [summary]);
    }
    return map;
  }, [projects]);

  const folders = React.useMemo(
    () =>
      [...grouped.keys()].sort((a, b) => {
        if (a === DEFAULT_PROJECT_FOLDER) return 1;
        if (b === DEFAULT_PROJECT_FOLDER) return -1;
        return a.localeCompare(b);
      }),
    [grouped],
  );

  const visibleFolders = folderFilter
    ? folders.filter((folder) => folder === folderFilter)
    : folders;

  const handleSave = useCallback(
    async (force = false) => {
      setBusy("Saving…");
      setError(null);
      try {
        // getFullProject() merges in text/shape/SVG/sticker clips, which live in the
        // engines rather than the store (see Stage 1 notes).
        const full = getFullProject();
        // Only sent when the picker has something in it: an empty field means "leave the
        // stored folder alone", which is what an ordinary save should do.
        const result = await saveServerProject(
          full,
          force ? null : knownUpdatedAt,
          saveFolder.trim() === "" ? undefined : saveFolder.trim(),
        );
        // Tell sync about a save it did not make, so its baseline and its idea of what
        // the server holds stay correct.
        noteServerSave(result.updatedAt);
        toast.success("Project saved to the server", full.name);
        await refresh();
      } catch (err) {
        if (err instanceof ProjectConflictError) {
          toast.error(
            "Someone else saved this project",
            "Reload theirs, or overwrite it from the panel.",
          );
        } else {
          const message = err instanceof Error ? err.message : "Unknown error";
          setError(message);
          toast.error("Could not save to the server", message);
        }
      } finally {
        setBusy(null);
      }
    },
    [getFullProject, knownUpdatedAt, noteServerSave, refresh, saveFolder],
  );

  /**
   * Re-files one project. Sends only the folder, over the narrow route — the list holds
   * summaries, so a full PUT would mean fetching the whole project to change one column.
   */
  const handleMove = useCallback(
    async (summary: ProjectSummary, folder: string) => {
      setBusy("Moving…");
      setError(null);
      try {
        const moved = await setServerProjectFolder(summary.id, folder.trim());
        setMovingId(null);
        setMoveFolder("");
        toast.success(`Moved to ${moved.folder}`, summary.name);
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        toast.error("Could not move the project", message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  /**
   * Deletes one project, after the card's confirm row has been armed.
   *
   * Deleting the project that is currently OPEN deliberately does not reset the editor.
   * The server copy and the in-memory one are separate things: wiping the timeline because
   * a server row went away would destroy unsaved work to enact a delete the user asked for
   * on the server, and there is no undo. So the editing session is left exactly as it is
   * and only the baseline is dropped — `knownUpdatedAt` pointed at a row that no longer
   * exists, and a save with a stale baseline would be a guard against nothing. With it
   * cleared, "Save to server" simply re-creates the project (PUT is an upsert). Media is
   * the one asymmetry: the sweep took the bytes the deleted project alone referenced, so a
   * re-save uploads JSON referencing media the server no longer has until those items are
   * re-imported. The toast says as much rather than hiding it.
   */
  const handleDelete = useCallback(
    async (summary: ProjectSummary) => {
      setBusy("Deleting…");
      setError(null);
      try {
        const result = await deleteServerProject(summary.id);
        setDeletingId(null);

        if (summary.id === project.id) {
          // The row is gone, so the guard has nothing to guard against; the next save
          // re-creates the project through the upsert.
          clearServerSyncConflict(null);
        }

        const swept = result.orphanedMediaRemoved.length;
        toast.success(
          `Deleted ${summary.name}`,
          [
            swept > 0
              ? swept === 1
                ? "1 media file nothing else referenced was removed too."
                : `${swept} media files nothing else referenced were removed too.`
              : null,
            summary.id === project.id
              ? "Still open here — saving will re-create it on the server."
              : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined,
        );
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        // Refresh before reporting, not after: the likeliest failure is a 404 because
        // someone else already deleted it, and re-listing makes that ghost card go away
        // instead of leaving a row that errors every time it is pressed. `refresh` clears
        // the error itself, so the message is set once it has finished.
        setDeletingId(null);
        await refresh();
        setError(message);
        toast.error("Could not delete the project", message);
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  const handleOpen = useCallback(
    async (summary: ProjectSummary) => {
      setBusy(`Opening ${summary.name}…`);
      setError(null);
      try {
        const record = await loadServerProject(summary.id);
        const incoming = record.project;

        // Media bytes are not in the JSON. Pull each item from the server and attach the
        // blob, so the project works on a browser with an empty local cache.
        const items = await Promise.all(
          (incoming.mediaLibrary?.items ?? []).map(async (item) => {
            // A JSON round-trip leaves `blob` as `{}`, so test for a real Blob.
            if (item.blob instanceof Blob) return item;
            const blob = await fetchServerMedia(item.id);
            if (!blob) return { ...item, isPlaceholder: true };
            try {
              await saveMediaBlob(incoming.id, item.id, blob, item.metadata);
            } catch {
              // Local cache write is best-effort; the in-memory blob is what matters.
            }
            return { ...item, blob, isPlaceholder: false };
          }),
        );

        const missing = items.filter((item) => item.isPlaceholder).length;
        const opened = { ...incoming, mediaLibrary: { items } };
        loadProject(opened);
        // From here on this project saves itself; the timestamp is the baseline that
        // makes those saves safe.
        // getFullProject(), not `opened`: sync hashes what the store plus the engines
        // hold, and a baseline hashed from a different shape would look like an edit.
        beginServerSync(getFullProject(), record.updatedAt);
        await refreshRegistry();

        toast.success(
          `Opened ${record.name}`,
          missing > 0
            ? `${items.length - missing}/${items.length} media files restored — ${missing} missing on the server.`
            : `${items.length} media file${items.length === 1 ? "" : "s"} restored from the server.`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        toast.error("Could not open the project", message);
      } finally {
        setBusy(null);
      }
    },
    [loadProject],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <p className="pt-2 pb-3 text-[12px] leading-snug text-fg-muted">
        Projects stored on the server, available from any browser. No sign-in: everyone
        sees the same list, and the last save wins.
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          aria-label="Save project to server now"
          disabled={busy !== null}
          onClick={() => void handleSave(false)}
          className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-semibold ${
            busy ? "bg-bg-2 text-fg-muted" : "bg-accent text-white"
          }`}
        >
          {busy === "Saving…" ? "Saving…" : "Save now"}
        </button>
        <button
          type="button"
          aria-label="Refresh server project list"
          disabled={busy !== null}
          onClick={() => void refresh()}
          className="rounded-lg border border-border/70 px-3 py-2 text-[12px] font-medium text-fg-muted"
        >
          Refresh
        </button>
      </div>

      <div className="mt-2">
        <FolderPicker
          id="server-projects-save-folder"
          label="Folder"
          ariaLabel="Save into folder"
          value={saveFolder}
          onChange={setSaveFolder}
          options={serverFolders}
          disabled={busy !== null}
        />
        <p className="mt-1 text-[11px] leading-4 text-fg-muted">
          Pick an existing folder or type a new one. Leave it blank to keep this project
          where it already is.
        </p>
      </div>

      <p className="mt-2 text-[11px] text-fg-muted">
        Current project: <span className="text-fg">{project.name}</span>
      </p>

      {error && (
        <p className="mt-3 break-words text-[11px] text-red-400" role="alert">
          {error}
        </p>
      )}

      {conflict && (
        <div
          className="mt-3 rounded-lg border border-amber-500/60 bg-amber-500/10 p-3"
          role="alert"
        >
          <p className="text-[12px] font-semibold text-fg">Someone else saved this project</p>
          <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">
            The server copy changed at{" "}
            {new Date(conflict.serverUpdatedAt).toLocaleTimeString()}; you opened the one from{" "}
            {new Date(conflict.yourUpdatedAt).toLocaleTimeString()}. There is no merge — pick one.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              aria-label="Overwrite the server copy"
              disabled={busy !== null}
              onClick={() => {
                clearServerSyncConflict(null);
                void handleSave(true);
              }}
              className="rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-black"
            >
              Overwrite theirs
            </button>
            <button
              type="button"
              aria-label="Discard my changes and reload the server copy"
              disabled={busy !== null}
              onClick={() => {
                const summary = projects?.find((item) => item.id === project.id);
                if (summary) void handleOpen(summary);
              }}
              className="rounded-md border border-border/70 px-2.5 py-1 text-[11px] font-medium text-fg-muted"
            >
              Load theirs (discards mine)
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-border/70 pt-3">
        {projects === null && !error && (
          <p className="text-[12px] text-fg-muted">Loading…</p>
        )}
        {projects?.length === 0 && (
          <p className="text-[12px] text-fg-muted">
            Nothing saved yet. Press “Save to server”.
          </p>
        )}
        {folders.length > 1 && (
          <div className="mb-3 flex items-center gap-2">
            <label
              htmlFor="server-projects-folder-filter"
              className="text-[11px] text-fg-muted"
            >
              Folder
            </label>
            <select
              id="server-projects-folder-filter"
              aria-label="Filter projects by folder"
              value={folderFilter}
              onChange={(event) => setFolderFilter(event.target.value)}
              className="flex-1 rounded-md border border-border/70 bg-bg-2 px-2 py-1 text-[12px] text-fg"
            >
              <option value="">All folders ({projects?.length ?? 0})</option>
              {folders.map((folder) => (
                <option key={folder} value={folder}>
                  {folder} ({grouped.get(folder)?.length ?? 0})
                </option>
              ))}
            </select>
          </div>
        )}

        {visibleFolders.length === 0 && projects && projects.length > 0 && (
          <p className="text-[12px] text-fg-muted">
            Nothing in “{folderFilter}”.
          </p>
        )}

        {visibleFolders.map((folder) => (
          <section key={folder} className="mb-3" aria-label={`Folder ${folder}`}>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              {folder}
              <span className="ml-1.5 font-normal normal-case tracking-normal">
                ({grouped.get(folder)!.length})
              </span>
            </h4>
            <ul className="flex flex-col gap-2">
              {grouped.get(folder)!.map((summary) => (
                <li key={summary.id}>
                  {/* Open and Move are siblings rather than nested: the card used to be one
                      big button, and a button inside a button is invalid. */}
                  <div
                    className={`flex items-start gap-1 rounded-lg border transition-colors ${
                      summary.id === project.id
                        ? "border-accent bg-selected"
                        : "border-border/70 bg-bg-2"
                    }`}
                  >
                    <button
                      type="button"
                      aria-label={`Open server project ${summary.name}`}
                      disabled={busy !== null}
                      onClick={() => void handleOpen(summary)}
                      className="min-w-0 flex-1 p-3 text-left"
                    >
                      <span className="block truncate text-[13px] font-semibold text-fg">
                        {summary.name}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-fg-muted">
                        {summary.folder} · updated{" "}
                        {new Date(summary.updatedAt).toLocaleString()}
                        {summary.id === project.id ? " · open" : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Move project ${summary.name} to a folder`}
                      aria-expanded={movingId === summary.id}
                      disabled={busy !== null}
                      onClick={() => {
                        const opening = movingId !== summary.id;
                        setMovingId(opening ? summary.id : null);
                        // Only one row open per card, so an armed delete cannot sit
                        // forgotten under a move form and be hit by accident.
                        if (opening) setDeletingId(null);
                        // Prefilled with where it already is, so the field shows the current
                        // answer rather than an empty box. The default folder is not a real
                        // folder, so it starts blank in that case.
                        setMoveFolder(
                          opening && summary.folder !== DEFAULT_PROJECT_FOLDER
                            ? summary.folder
                            : "",
                        );
                      }}
                      className="m-2 shrink-0 rounded-md border border-border/70 px-2 py-1 text-[11px] font-medium text-fg-muted"
                    >
                      Move
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete project ${summary.name}`}
                      aria-expanded={deletingId === summary.id}
                      disabled={busy !== null}
                      onClick={() => {
                        const opening = deletingId !== summary.id;
                        setDeletingId(opening ? summary.id : null);
                        if (opening) setMovingId(null);
                      }}
                      className="my-2 mr-2 shrink-0 rounded-md border border-border/70 px-2 py-1 text-[11px] font-medium text-fg-muted hover:border-red-500/60 hover:text-red-400"
                    >
                      Delete
                    </button>
                  </div>

                  {deletingId === summary.id && (
                    <div
                      className="mt-1.5 rounded-lg border border-red-500/60 bg-red-500/10 p-2"
                      role="alert"
                    >
                      <p className="text-[12px] leading-snug text-fg">
                        Delete <span className="font-semibold">{summary.name}</span> from
                        the server?
                      </p>
                      <p className="mt-0.5 text-[11px] leading-4 text-fg-muted">
                        This cannot be undone, and media only this project uses is deleted
                        with it.
                        {summary.id === project.id
                          ? " It stays open in the editor — saving would re-create it."
                          : ""}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          aria-label={`Confirm deleting ${summary.name}`}
                          disabled={busy !== null}
                          onClick={() => void handleDelete(summary)}
                          className="rounded-md bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel deleting ${summary.name}`}
                          disabled={busy !== null}
                          onClick={() => setDeletingId(null)}
                          className="rounded-md border border-border/70 px-2.5 py-1 text-[11px] font-medium text-fg-muted"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {movingId === summary.id && (
                    <div className="mt-1.5 rounded-lg border border-border/70 bg-bg-2 p-2">
                      <FolderPicker
                        id={`server-projects-move-${summary.id}`}
                        label="To"
                        ariaLabel={`New folder for ${summary.name}`}
                        value={moveFolder}
                        onChange={setMoveFolder}
                        options={serverFolders}
                        disabled={busy !== null}
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          aria-label={`Confirm moving ${summary.name}`}
                          disabled={busy !== null}
                          onClick={() => void handleMove(summary, moveFolder)}
                          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white"
                        >
                          Move
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel moving ${summary.name}`}
                          disabled={busy !== null}
                          onClick={() => {
                            setMovingId(null);
                            setMoveFolder("");
                          }}
                          className="rounded-md border border-border/70 px-2.5 py-1 text-[11px] font-medium text-fg-muted"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-4 text-fg-muted">
                        Blank moves it back to {DEFAULT_PROJECT_FOLDER}.
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {busy && busy !== "Saving…" && (
        <p className="mt-3 text-[11px] text-fg-muted">{busy}</p>
      )}
    </div>
  );
};

export default ServerProjectsPanel;
