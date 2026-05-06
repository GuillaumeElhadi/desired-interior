import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50">
      <h1 className="text-4xl font-bold text-gray-900">Interior Vision — Hello</h1>
      {health.status === "loading" && <p className="text-sm text-gray-500">Connecting to API…</p>}
      {health.status === "ok" && (
        <p className="text-sm text-green-600">API healthy · v{health.version}</p>
      )}
      {health.status === "error" && (
        <p className="text-sm text-red-600">API error: {health.error}</p>
      )}
    </main>
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
