import { invoke } from "@tauri-apps/api/core";
import type { components } from "@interior-vision/shared-types";

export type HealthResponse = components["schemas"]["HealthResponse"];
export type LogEntry = components["schemas"]["LogEntry"];
export type LogRequest = components["schemas"]["LogRequest"];

export async function getApiBaseUrl(): Promise<string> {
  return invoke<string>("api_base_url");
}

async function getIpcToken(): Promise<string> {
  return invoke<string>("ipc_token");
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getIpcToken();
  const { headers: extraHeaders, ...rest } = options;
  return fetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(extraHeaders as Record<string, string> | undefined),
    },
  });
}

export async function checkHealth(): Promise<HealthResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchWithAuth(`${baseUrl}/health`);
  if (!response.ok) {
    throw new Error(`health check failed: ${response.status}`);
  }
  return response.json() as Promise<HealthResponse>;
}

export async function postLog(body: LogRequest): Promise<void> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchWithAuth(`${baseUrl}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`log upload failed: ${response.status}`);
  }
}
