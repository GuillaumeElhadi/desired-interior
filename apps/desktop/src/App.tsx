import { useEffect, useState } from "react";
import { checkHealth } from "./lib/api";

interface HealthState {
  status: "loading" | "ok" | "error";
  version?: string;
  error?: string;
}

function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    checkHealth()
      .then(({ version }) => setHealth({ status: "ok", version }))
      .catch((err: unknown) => setHealth({ status: "error", error: String(err) }));
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

export default App;
