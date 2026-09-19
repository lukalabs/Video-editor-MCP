import React from "react";
import { ToolcraftText as Text } from "@openreel/ui";
import { Check, CloudOff, Loader2, TriangleAlert } from "@/icons/lucide-compat";
import { useProjectStore } from "../../stores/project-store";

/**
 * Whether the server has this project's latest state.
 *
 * The conflict UI already existed, but only inside the Projects panel - somewhere you
 * might never open. Now that saving is automatic, the one thing a person cannot be left
 * to guess is whether it is actually happening, so the status lives in the header where
 * a stalled or conflicted save is visible without going looking for it.
 */

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export const ServerSyncIndicator: React.FC = () => {
  const serverSync = useProjectStore((state) => state.serverSync);
  const hasOpenProject = useProjectStore((state) => state.hasOpenProject);

  if (!hasOpenProject) return null;

  const { status, lastSavedAt, error, conflict } = serverSync;

  const presentation = (() => {
    switch (status) {
      case "saving":
        return {
          label: "Saving…",
          tone: "text-fg-muted",
          icon: <Loader2 size={12} className="animate-spin" aria-hidden />,
          title: "Saving to the server",
        };
      case "saved":
        return {
          label: lastSavedAt ? `Saved ${relativeTime(lastSavedAt)}` : "Saved",
          tone: "text-fg-muted",
          icon: <Check size={12} aria-hidden />,
          title: "The server has your latest changes",
        };
      case "unsaved":
        return {
          label: "Unsaved",
          tone: "text-fg-muted",
          icon: <Loader2 size={12} aria-hidden />,
          title: "Changes are queued and will save in a moment",
        };
      case "conflict":
        return {
          label: "Conflict",
          tone: "text-amber-400",
          icon: <TriangleAlert size={12} aria-hidden />,
          title: conflict
            ? `Someone else saved this project at ${new Date(
                conflict.serverUpdatedAt,
              ).toLocaleTimeString()}. Automatic saving has stopped — resolve it in the Projects panel.`
            : "Automatic saving has stopped because the project changed elsewhere",
        };
      case "error":
        return {
          label: "Not saved",
          tone: "text-red-400",
          icon: <CloudOff size={12} aria-hidden />,
          title: error
            ? `${error}. Retrying; your work is still saved in this browser.`
            : "Could not reach the server; retrying",
        };
      case "idle":
      default:
        return null;
    }
  })();

  if (!presentation) return null;

  return (
    <div
      className={`flex items-center gap-1.5 ${presentation.tone}`}
      title={presentation.title}
      role="status"
      aria-live="polite"
      data-testid="server-sync-indicator"
    >
      {presentation.icon}
      <Text type="supporting" className="text-[11px]">
        {presentation.label}
      </Text>
    </div>
  );
};

export default ServerSyncIndicator;
