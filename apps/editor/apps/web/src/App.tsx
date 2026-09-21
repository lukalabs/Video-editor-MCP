import { useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { ToastContainer } from "./components/Toast";
import { ScriptViewDialog } from "./components/editor/ScriptViewDialog";
import { SearchModal } from "./components/editor/SearchModal";
import { MobileBlocker } from "./components/MobileBlocker";
import { WelcomeScreen } from "./components/welcome";
import { RecoveryDialog } from "./components/welcome/RecoveryDialog";
import { SharePage } from "./pages/SharePage";
import { useUIStore } from "./stores/ui-store";
import { useProjectStore } from "./stores/project-store";
import { toast } from "./stores/notification-store";
import { useRouter } from "./hooks/use-router";
import { useProjectRecovery } from "./hooks/useProjectRecovery";
import { useKieAIPoller } from "./hooks/useKieAIPoller";
import {
  SOCIAL_MEDIA_PRESETS,
  createProjectSerializer,
  createStorageEngine,
  type SocialMediaCategory,
} from "@openreel/core";
import { ToolcraftText as Text } from "@openreel/ui";

const EditorInterface = lazy(() =>
  import("./components/editor/EditorInterface").then((m) => ({
    default: m.EditorInterface,
  }))
);
const MotionCreatorApp = lazy(() =>
  import("./motion/MotionCreatorApp").then((module) => ({
    default: module.MotionCreatorApp,
  }))
);

const LoadingSpinner: React.FC<{ message: string }> = ({ message }) => (
  <div className="h-screen w-screen bg-background flex flex-col items-center justify-center">
    <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
    <Text type="supporting" color="secondary" className="text-sm text-text-secondary">{message}</Text>
  </div>
);

const PRESET_DIMENSIONS: Record<string, SocialMediaCategory> = {
  "1080x1920": "tiktok",
  "1920x1080": "youtube-video",
  "1080x1080": "instagram-post",
  "720x1280": "instagram-stories",
  "1280x720": "youtube-video",
};

function App() {
  const { activeModal, closeModal, skipWelcomeScreen } = useUIStore();
  const { openModal: openSearchModal } = useUIStore();
  const createNewProject = useProjectStore((state) => state.createNewProject);
  const { showDialog, availableSaves, recover, dismiss, clearAll } = useProjectRecovery();

  const { route, params, navigate, parsedDimensions, fps } = useRouter();
  const hasHandledInitialRoute = useRef(false);
  const isMotionHost =
    typeof window !== "undefined" &&
    window.location.hostname.startsWith("motion.");
  const isMotionSurface = isMotionHost || route === "motion";

  useKieAIPoller();

  useEffect(() => {
    if (hasHandledInitialRoute.current) return;

    if (isMotionSurface) {
      hasHandledInitialRoute.current = true;
    } else if (route === "new") {
      hasHandledInitialRoute.current = true;

      let projectName = "New Project";
      let width = 1920;
      let height = 1080;
      let frameRate = fps;

      if (params.preset) {
        const presetKey = params.preset as SocialMediaCategory;
        const preset = SOCIAL_MEDIA_PRESETS[presetKey];
        if (preset) {
          width = preset.width;
          height = preset.height;
          frameRate = preset.frameRate || fps;
          projectName = `New ${presetKey.charAt(0).toUpperCase() + presetKey.slice(1).replace(/-/g, " ")} Project`;
        }
      } else if (parsedDimensions) {
        width = parsedDimensions.width;
        height = parsedDimensions.height;

        const dimensionKey = `${width}x${height}`;
        const matchingPreset = PRESET_DIMENSIONS[dimensionKey];
        if (matchingPreset) {
          const preset = SOCIAL_MEDIA_PRESETS[matchingPreset];
          frameRate = preset.frameRate || fps;
        }

        const aspectRatio = width / height;
        if (aspectRatio < 1) {
          projectName = "New Vertical Video";
        } else if (aspectRatio > 1) {
          projectName = "New Horizontal Video";
        } else {
          projectName = "New Square Video";
        }
      }

      createNewProject(projectName, { width, height, frameRate });
      navigate("editor");
    } else if (route === "editor" && skipWelcomeScreen) {
      hasHandledInitialRoute.current = true;
    } else if (["welcome", "templates", "recent"].includes(route)) {
      hasHandledInitialRoute.current = true;
    }
  }, [
    route,
    isMotionSurface,
    params,
    parsedDimensions,
    fps,
    createNewProject,
    navigate,
    skipWelcomeScreen,
  ]);

  // `?open=<url>` loads a project JSON straight into the editor, so a project built
  // outside the browser (see tools/project-cli) can be opened with a link rather than
  // hand-imported. The URL must be same-origin: serve the file from the dev server.
  const openedProjectUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!params.open) return;
    const requested = `${params.open}|${params.media ?? ""}`;
    if (openedProjectUrl.current === requested) return;
    openedProjectUrl.current = requested;

    const url = params.open;
    const mediaBase = params.media;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const serializer = createProjectSerializer(createStorageEngine());
        const { project, validation } = serializer.importFromJsonWithValidation(
          await response.text(),
        );
        if (!project || !validation.valid) {
          toast.error(
          "Could not open project",
            validation.errors[0] ?? "The file did not validate",
          );
          return;
        }

        useProjectStore.getState().loadProject(project);
        navigate("editor");

        // A project built outside the browser has no media blobs, only file names. With
        // `media=<base>` the loader fetches each one by name and attaches it, so the
        // project opens ready to play instead of asking for a manual relink.
        const missing = project.mediaLibrary.items.filter((item) => !item.blob);
        if (missing.length === 0) return;

        if (!mediaBase) {
          toast.warning(
            `${missing.length} asset${missing.length !== 1 ? "s" : ""} need relinking`,
            'Assets panel -> "Relink from Folder" to restore the media.',
          );
          return;
        }

        const base = mediaBase.replace(/\/$/, "");
        let restored = 0;
        const failures: string[] = [];
        for (const item of missing) {
          const fileName = item.sourceFile?.name ?? item.name;
          try {
            const media = await fetch(`${base}/${encodeURIComponent(fileName)}`);
            if (!media.ok) continue;
            const blob = await media.blob();
            const file = new File([blob], fileName, {
              type: blob.type || media.headers.get("content-type") || "",
            });
            const result = await useProjectStore
              .getState()
              .replaceMediaAsset(item.id, file, base);
            if (result?.success === false) {
              failures.push(`${fileName}: ${result.error?.message ?? "could not be decoded"}`);
              continue;
            }
            restored += 1;
          } catch (error) {
            failures.push(
              `${fileName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (restored === missing.length) {
          toast.success(`Loaded ${restored} asset${restored !== 1 ? "s" : ""}`);
        } else {
          toast.warning(
            `Loaded ${restored} of ${missing.length} assets`,
            failures[0] ?? 'Assets panel -> "Relink from Folder" for the rest.',
          );
          console.warn("[open] assets that did not load:", failures);
        }
      } catch (error) {
        toast.error(
          "Could not open project",
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  }, [params.open, params.media, navigate]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && route !== "editor") {
        navigate("editor");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearchModal("search");
      }
    },
    [route, navigate, openSearchModal],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const showWelcome =
    ["welcome", "templates", "recent"].includes(route) && !skipWelcomeScreen;
  const initialTab =
    route === "templates"
      ? "templates"
      : route === "recent"
        ? "recent"
        : undefined;
  const isSharePage = route === "share" && params.shareId;

  return (
    <div className="h-screen w-screen bg-background text-text-primary overflow-hidden">
      <MobileBlocker />
      {isMotionSurface ? (
        <Suspense fallback={<LoadingSpinner message="Loading Motion Creator..." />}>
          <MotionCreatorApp />
        </Suspense>
      ) : isSharePage ? (
        <SharePage shareId={params.shareId!} />
      ) : showWelcome ? (
        <WelcomeScreen initialTab={initialTab} />
      ) : (
        <Suspense fallback={<LoadingSpinner message="Loading editor..." />}>
          <EditorInterface />
        </Suspense>
      )}
      <ToastContainer />
      <ScriptViewDialog
        isOpen={activeModal === "scriptView"}
        onClose={closeModal}
      />
      <SearchModal isOpen={activeModal === "search"} onClose={closeModal} />
      {showDialog && availableSaves.length > 0 && (
        <RecoveryDialog
          saves={availableSaves}
          onRecover={async (saveId) => {
            const success = await recover(saveId);
            if (success) navigate("editor");
          }}
          onDismiss={dismiss}
          onClearAll={clearAll}
        />
      )}
    </div>
  );
}

export default App;
