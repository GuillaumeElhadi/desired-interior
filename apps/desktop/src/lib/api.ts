import { invoke } from "@tauri-apps/api/core";
import type { components } from "@interior-vision/shared-types";

export type HealthResponse = components["schemas"]["HealthResponse"];

export async function getApiBaseUrl(): Promise<string> {
  return invoke<string>("api_base_url");
}

async function getIpcToken(): Promise<string> {
  return invoke<string>("ipc_token");
}

async function fetchWithAuth(url: string): Promise<Response> {
  const token = await getIpcToken();
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

export async function checkHealth(): Promise<HealthResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchWithAuth(`${baseUrl}/health`);
  if (!response.ok) {
    throw new Error(`health check failed: ${response.status}`);
  }
  return response.json() as Promise<HealthResponse>;
}
