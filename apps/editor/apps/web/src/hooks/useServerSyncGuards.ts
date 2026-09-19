import { useEffect } from "react";
import { useProjectStore } from "../stores/project-store";
import { serverSyncManager } from "../services/server-sync";
import { serializeProjectForAutoSave } from "../services/auto-save";

/**
 * The moments where a tab can take unsaved work with it.
 *
 * Automatic sync already narrows the window to a few seconds, but "a few seconds" is
 * exactly how long it takes to close a laptop lid after the last edit. These hooks
 * close it further:
 *
 *  - hidden / blurred: flush properly, with a normal request, while the page is alive.
 *  - unloading: one last keepalive request, which the browser is allowed to finish
 *    after the page is gone, and a confirmation prompt if anything is still pending.
 */

/** Chrome's documented cap for the combined body size of keepalive requests. */
const KEEPALIVE_LIMIT_BYTES = 64 * 1024;

const BASE =
  (import.meta.env.VITE_RENDER_SERVICE_URL as string | undefined) ??
  "http://127.0.0.1:3001";

/**
 * Best-effort save during unload.
 *
 * sendBeacon cannot be used: it only issues POSTs and this route is a PUT. fetch with
 * keepalive can, within the size cap - over that the browser rejects it, so the
 * confirmation prompt is the remaining protection.
 */
function flushOnUnload(): void {
  const payload = serverSyncManager.pendingPayload();
  if (!payload) return;

  const body = JSON.stringify({
    name: payload.project.name,
    project: JSON.parse(serializeProjectForAutoSave(payload.project)),
    ...(payload.expectedUpdatedAt != null
      ? { expectedUpdatedAt: payload.expectedUpdatedAt }
      : {}),
  });

  if (body.length > KEEPALIVE_LIMIT_BYTES) return;

  try {
    void fetch(`${BASE}/projects/${encodeURIComponent(payload.project.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    // Nothing useful to do while the page is going away.
  }
}

export function useServerSyncGuards(): void {
  const getFullProject = useProjectStore((state) => state.getFullProject);

  useEffect(() => {
    const flush = () => {
      void serverSyncManager.flushNow(getFullProject());
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      flushOnUnload();
      if (!serverSyncManager.hasUnsyncedChanges()) return;
      // Only asks when something really is pending, which after automatic sync is a
      // window of seconds rather than "until you remember to press save".
      event.preventDefault();
      event.returnValue = "";
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [getFullProject]);
}
