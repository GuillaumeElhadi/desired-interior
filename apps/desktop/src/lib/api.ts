import { invoke } from "@tauri-apps/api/core";
import type { components } from "@interior-vision/shared-types";

export type HealthResponse = components["schemas"]["HealthResponse"];
export type LogEntry = components["schemas"]["LogEntry"];
export type LogRequest = components["schemas"]["LogRequest"];
export type PreprocessResponse = components["schemas"]["PreprocessResponse"];
export type ExtractResponse = components["schemas"]["ExtractResponse"];
export type ComposeRequest = components["schemas"]["ComposeRequest"];
export type ComposeResponse = components["schemas"]["ComposeResponse"];
export type PreviewComposeResponse = components["schemas"]["PreviewComposeResponse"];

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

export async function preprocessScene(file: File): Promise<PreprocessResponse> {
  const baseUrl = await getApiBaseUrl();
  const form = new FormData();
  form.append("image", file);
  const response = await fetchWithAuth(`${baseUrl}/scenes/preprocess`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`preprocess failed: ${response.status}`);
  }
  return response.json() as Promise<PreprocessResponse>;
}

export async function extractObject(file: File): Promise<ExtractResponse> {
  const baseUrl = await getApiBaseUrl();
  const form = new FormData();
  form.append("image", file);
  const response = await fetchWithAuth(`${baseUrl}/objects/extract`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`extract failed: ${response.status}`);
  }
  return response.json() as Promise<ExtractResponse>;
}

export async function compose(
  request: ComposeRequest,
  signal?: AbortSignal
): Promise<ComposeResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchWithAuth(`${baseUrl}/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const msg = await response.text().catch(() => response.statusText);
    throw new Error(`compose failed: ${response.status} ${msg}`);
  }
  return response.json() as Promise<ComposeResponse>;
}

export async function composePreview(
  request: ComposeRequest,
  signal?: AbortSignal
): Promise<PreviewComposeResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchWithAuth(`${baseUrl}/compose/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const msg = await response.text().catch(() => response.statusText);
    throw new Error(`composePreview failed: ${response.status} ${msg}`);
  }
  return response.json() as Promise<PreviewComposeResponse>;
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
