import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ObjectPanel } from "./components/ObjectPanel";
import { PlacementCanvas } from "./components/PlacementCanvas";
import { RoomUpload, type SceneContext } from "./components/RoomUpload";
import { checkHealth } from "./lib/api";

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

function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [sceneCtx, setSceneCtx] = useState<SceneContext | null>(null);

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
        <span className="text-xs text-gray-400">
          {health.status === "loading" && "Connecting to API…"}
          {health.status === "ok" && `API healthy · v${health.version}`}
          {health.status === "error" && (
            <span className="text-red-500">API error: {health.error}</span>
          )}
        </span>
      </header>

      <main className="flex flex-1 overflow-hidden">
        {sceneCtx ? (
          <>
            <PlacementCanvas
              sceneId={sceneCtx.sceneId}
              imageUrl={sceneCtx.imageUrl}
              masks={sceneCtx.masks}
            />
            <ObjectPanel sceneId={sceneCtx.sceneId} />
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
