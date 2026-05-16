import { useCallback, useEffect, useState } from "react";
import { ConsentBanner } from "./components/ConsentBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OfflineBanner } from "./components/OfflineBanner";
import { ObjectPanel } from "./components/ObjectPanel";
import { PlacementCanvas } from "./components/PlacementCanvas";
import { ResultView } from "./components/ResultView";
import { RoomUpload, type SceneContext } from "./components/RoomUpload";
import { SettingsPanel } from "./components/SettingsPanel";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { type ObjectPlacement, checkHealth, harmonize, updateSettings } from "./lib/api";
import { toUserMessage } from "./lib/errors";
import { loadSettings, saveSettings } from "./lib/settings";
import { loadSceneVariant, saveSceneVariant } from "./lib/sceneStore";
import * as telemetry from "./lib/telemetry";

interface HealthState {
  status: "loading" | "ok" | "error";
  version?: string;
  error?: string;
  errorCode?: string;
}

// Retry checkHealth until the PyInstaller sidecar finishes starting.
// Delays: 300ms, 600ms, 1.2s, 2s, 2s, … — gives the binary ~8s total.
async function waitForSidecar(signal: AbortSignal): Promise<{ version: string }> {
  const delays = [300, 600, 1200, 2000, 2000, 2000];
  let lastError: unknown;
  for (let i = 0; i <= delays.length; i++) {
    if (signal.aborted) throw new Error("aborted");
    try {
      return await checkHealth();
    } catch (err) {
      lastError = err;
      if (i < delays.length) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delays[i]);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }
    }
  }
  throw lastError;
}

interface RenderResult {
  url: string;
  compositionId: string;
  sceneId: string;
  objects: ObjectPlacement[];
}

function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [sceneCtx, setSceneCtx] = useState<SceneContext | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [pendingObjectId, setPendingObjectId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [falKeyConfigured, setFalKeyConfigured] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [analyticsDecided, setAnalyticsDecided] = useState(true);
  const [harmonizeStrength, setHarmonizeStrength] = useState(0.38);
  const [cleanedVariant, setCleanedVariant] = useState<{
    sceneId: string;
    imageUrl: string;
  } | null>(null);
  const [isShowingCleanedScene, setIsShowingCleanedScene] = useState(false);
  const [originalSceneCtx, setOriginalSceneCtx] = useState<SceneContext | null>(null);
  const isOnline = useOnlineStatus();

  useEffect(() => {
    const controller = new AbortController();
    // Load the stored FAL_KEY first, then wait for the sidecar to be ready
    // before pushing it — avoids a race where the key is sent before the
    // sidecar has bound its port.
    const init = async () => {
      const {
        falKey,
        analyticsEnabled,
        anonymousId,
        harmonizeStrength: savedStrength,
      } = await loadSettings();
      setFalKeyConfigured(!!falKey);
      setAnalyticsDecided(analyticsEnabled !== undefined);
      if (savedStrength !== undefined) setHarmonizeStrength(savedStrength);
      if (analyticsEnabled !== undefined) {
        telemetry.init(analyticsEnabled, anonymousId ?? "");
      }
      const { version } = await waitForSidecar(controller.signal);
      setHealth({ status: "ok", version });
      if (falKey) {
        await updateSettings({ fal_key: falKey }).catch(console.error);
      }
    };

    init().catch((err: unknown) => {
      if (String(err).includes("aborted")) return;
      const msg = toUserMessage(err);
      const code =
        typeof err === "object" && err !== null && "errorCode" in err
          ? String((err as { errorCode: unknown }).errorCode)
          : "unknown";
      setHealth({ status: "error", error: msg.detail, errorCode: code });
    });

    return () => controller.abort();
  }, [retryCount]);

  const handleRetryHealth = useCallback(() => {
    setHealth({ status: "loading" });
    setRetryCount((c) => c + 1);
  }, []);

  const handleConsentAllow = useCallback(() => {
    const anonymousId = crypto.randomUUID();
    telemetry.init(true, anonymousId);
    setAnalyticsDecided(true);
    loadSettings()
      .then((s) => saveSettings({ ...s, analyticsEnabled: true, anonymousId }))
      .catch(console.error);
  }, []);

  const handleConsentDecline = useCallback(() => {
    telemetry.init(false, "");
    setAnalyticsDecided(true);
    loadSettings()
      .then((s) => saveSettings({ ...s, analyticsEnabled: false }))
      .catch(console.error);
  }, []);

  // Reset variant state when scene changes — render-time setState avoids the
  // react-hooks/set-state-in-effect rule (same pattern as PlacementCanvas prevImageUrl).
  const [prevSceneId, setPrevSceneId] = useState<string | undefined>(sceneCtx?.sceneId);
  if (prevSceneId !== sceneCtx?.sceneId) {
    setPrevSceneId(sceneCtx?.sceneId);
    setCleanedVariant(null);
    setIsShowingCleanedScene(false);
    setOriginalSceneCtx(null);
  }

  // Rehydrate cleaned variant from store when a scene is loaded
  useEffect(() => {
    if (!sceneCtx?.sceneId) return;
    loadSceneVariant(sceneCtx.sceneId)
      .then((v) => {
        // Validate the stored URL is a data URL to prevent open-redirect if the
        // store file were ever corrupted or tampered (defence-in-depth).
        if (v && v.cleanedUrl.startsWith("data:image/")) {
          setCleanedVariant({ sceneId: v.cleanedSceneId, imageUrl: v.cleanedUrl });
        }
      })
      .catch(console.error);
  }, [sceneCtx?.sceneId]);

  const handleSceneCleaned = useCallback(
    (cleanedSceneId: string, cleanedUrl: string) => {
      if (!sceneCtx) return;
      const variant = { sceneId: cleanedSceneId, imageUrl: cleanedUrl };
      setCleanedVariant(variant);
      saveSceneVariant(sceneCtx.sceneId, {
        cleanedSceneId,
        cleanedUrl,
      }).catch(console.error);
    },
    [sceneCtx]
  );

  const handleUseCleanedScene = useCallback(() => {
    if (!sceneCtx || !cleanedVariant) return;
    if (!originalSceneCtx) setOriginalSceneCtx(sceneCtx);
    setSceneCtx((prev) =>
      prev ? { ...prev, sceneId: cleanedVariant.sceneId, imageUrl: cleanedVariant.imageUrl } : prev
    );
    setIsShowingCleanedScene(true);
  }, [sceneCtx, cleanedVariant, originalSceneCtx]);

  const handleRestoreOriginal = useCallback(() => {
    const orig = originalSceneCtx;
    if (!orig) return;
    setSceneCtx(orig);
    setIsShowingCleanedScene(false);
  }, [originalSceneCtx]);

  const handleHarmonize = useCallback(
    async (signal: AbortSignal, strength: number) => {
      const response = await harmonize(
        {
          scene_id: renderResult!.sceneId,
          objects: renderResult!.objects,
          harmonize_strength: strength,
        },
        signal
      );
      return response.image.url;
    },
    [renderResult]
  );

  const handleStrengthChange = useCallback((s: number) => {
    setHarmonizeStrength(s);
    loadSettings()
      .then((st) => saveSettings({ ...st, harmonizeStrength: s }))
      .catch(console.error);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <h1 className="text-base font-semibold text-gray-900">Interior Vision</h1>
        <div className="flex items-center gap-4">
          {!falKeyConfigured && (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label="Configure fal.ai API key — required for rendering"
              onClick={() => setShowSettings(true)}
              className="rounded-md bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100"
            >
              <span aria-hidden="true">⚠</span> Configure API key
            </button>
          )}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="text-xs text-gray-400"
          >
            {health.status === "loading" && "Connecting…"}
            {health.status === "ok" && `API v${health.version}`}
            {health.status === "error" && (
              <span className="inline-flex items-center gap-2 text-red-600">
                {health.errorCode === "sidecar_unreachable" ? "Service unavailable" : "API error"}
                <button
                  type="button"
                  onClick={handleRetryHealth}
                  className="rounded-md bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 hover:bg-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  Retry
                </button>
              </span>
            )}
          </span>
          <button
            type="button"
            aria-label="Open settings"
            aria-haspopup="dialog"
            onClick={() => setShowSettings(true)}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>
      </header>

      {!isOnline && <OfflineBanner />}

      {!analyticsDecided && (
        <ConsentBanner onAllow={handleConsentAllow} onDecline={handleConsentDecline} />
      )}

      {showSettings && (
        <SettingsPanel
          onClose={() => {
            setShowSettings(false);
            // Refresh falKeyConfigured after save
            loadSettings()
              .then(({ falKey }) => setFalKeyConfigured(!!falKey))
              .catch(console.error);
          }}
        />
      )}

      <main className="flex flex-1 overflow-hidden">
        {sceneCtx && renderResult ? (
          <>
            <ResultView
              originalUrl={sceneCtx.imageUrl}
              resultUrl={renderResult.url}
              onBack={() => setRenderResult(null)}
              onRerender={() => setRenderResult(null)}
              onHarmonize={handleHarmonize}
              initialStrength={harmonizeStrength}
              onStrengthChange={handleStrengthChange}
            />
            <ObjectPanel sceneId={sceneCtx.sceneId} />
          </>
        ) : sceneCtx ? (
          <>
            <PlacementCanvas
              sceneId={sceneCtx.sceneId}
              imageUrl={sceneCtx.imageUrl}
              masks={sceneCtx.masks}
              onRenderComplete={setRenderResult}
              pendingObjectId={pendingObjectId}
              onPendingObjectPlaced={() => setPendingObjectId(null)}
              falKeyConfigured={falKeyConfigured}
              onOpenSettings={() => setShowSettings(true)}
              onSceneCleaned={handleSceneCleaned}
              cleanedVariant={cleanedVariant}
              onUseCleanedScene={handleUseCleanedScene}
              onRestoreOriginal={handleRestoreOriginal}
              isShowingCleanedScene={isShowingCleanedScene}
            />
            <ObjectPanel
              sceneId={sceneCtx.sceneId}
              pendingObjectId={pendingObjectId}
              onObjectSelect={(id) => setPendingObjectId((prev) => (prev === id ? null : id))}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900">Upload a room photo</h2>
              <p className="mt-1 text-sm text-gray-500">
                We&apos;ll analyse the scene and prepare it for object placement.
              </p>
            </div>
            <RoomUpload disabled={health.status !== "ok"} onSceneReady={setSceneCtx} />
          </div>
        )}
      </main>
    </div>
  );
}

function AppWithBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default AppWithBoundary;
