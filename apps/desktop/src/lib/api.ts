import { invoke } from "@tauri-apps/api/core";

export async function getApiBaseUrl(): Promise<string> {
  return invoke<string>("api_base_url");
}

export async function checkHealth(): Promise<{ status: string; version: string }> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) {
    throw new Error(`health check failed: ${response.status}`);
  }
  return response.json() as Promise<{ status: string; version: string }>;
}
