import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ObjectPanel } from "./components/ObjectPanel";
import { PlacementCanvas } from "./components/PlacementCanvas";
import { ResultView } from "./components/ResultView";
import { RoomUpload, type SceneContext } from "./components/RoomUpload";
import { SettingsPanel } from "./components/SettingsPanel";
import { checkHealth, updateSettings } from "./lib/api";
import { loadSettings } from "./lib/settings";

interface HealthState {
  status: "loading" | "ok" | "error";
  version?: string;
  error?: string;
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
}

function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [sceneCtx, setSceneCtx] = useState<SceneContext | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [pendingObjectId, setPendingObjectId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [falKeyConfigured, setFalKeyConfigured] = useState(false);

  // Load settings from store and push FAL_KEY to the sidecar once it's ready.
  useEffect(() => {
    loadSettings()
      .then(async ({ falKey }) => {
        setFalKeyConfigured(!!falKey);
        if (falKey) {
          await updateSettings({ fal_key: falKey }).catch(console.error);
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    waitForSidecar(controller.signal)
      .then(({ version }) => setHealth({ status: "ok", version }))
      .catch((err: unknown) => {
        if (String(err).includes("aborted")) return;
        setHealth({ status: "error", error: String(err) });
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <h1 className="text-base font-semibold text-gray-900">Interior Vision</h1>
        <div className="flex items-center gap-4">
          {!falKeyConfigured && (
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="rounded-md bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-300 hover:bg-amber-100"
            >
              ⚠ Configure API key
            </button>
          )}
          <span className="text-xs text-gray-400">
            {health.status === "loading" && "Connecting to API…"}
            {health.status === "ok" && `API healthy · v${health.version}`}
            {health.status === "error" && (
              <span className="text-red-500">API error: {health.error}</span>
            )}
          </span>
          <button
            type="button"
            aria-label="Open settings"
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
