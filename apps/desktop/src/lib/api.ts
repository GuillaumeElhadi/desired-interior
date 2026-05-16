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

// ---------------------------------------------------------------------------
// ApiError — structured error thrown by every API call
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly errorCode: string;
  readonly httpStatus: number;
  readonly requestId: string | undefined;

  constructor(errorCode: string, httpStatus: number, message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    let errorCode = _statusToCode(response.status);
    let message = response.statusText || `HTTP ${response.status}`;
    let requestId: string | undefined;
    try {
      // Read text first — body stream can only be consumed once, so we parse
      // JSON ourselves rather than calling response.json() then response.text().
      const text = await response.text();
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        if (typeof body.error_code === "string") errorCode = body.error_code;
        else if (typeof body.error === "string") errorCode = body.error;
        if (typeof body.message === "string") message = body.message;
        if (typeof body.request_id === "string") requestId = body.request_id;
      } catch {
        if (text) message = text;
      }
    } catch {
      /* ignore — statusText fallback already set above */
    }
    return new ApiError(errorCode, response.status, message, requestId);
  }

  static fromNetworkError(err: unknown): ApiError {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return new ApiError("offline", 0, "No internet connection");
    }
    const message = err instanceof Error ? err.message : String(err);
    return new ApiError("sidecar_unreachable", 0, message);
  }
}

function _statusToCode(status: number): string {
  const map: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "gateway_timeout",
  };
  return map[status] ?? "server_error";
}

// ---------------------------------------------------------------------------
// Core fetch helpers
// ---------------------------------------------------------------------------

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

/** Fetch with auth, parse errors into ApiError, throw on non-ok. */
async function safeFetch(url: string, options: RequestInit = {}): Promise<Response> {
  try {
    const response = await fetchWithAuth(url, options);
    if (!response.ok) {
      throw await ApiError.fromResponse(response);
    }
    return response;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.fromNetworkError(err);
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function checkHealth(): Promise<HealthResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await safeFetch(`${baseUrl}/health`);
  return response.json() as Promise<HealthResponse>;
}

export async function preprocessScene(file: File): Promise<PreprocessResponse> {
  const baseUrl = await getApiBaseUrl();
  const form = new FormData();
  form.append("image", file);
  const response = await safeFetch(`${baseUrl}/scenes/preprocess`, {
    method: "POST",
    body: form,
  });
  return response.json() as Promise<PreprocessResponse>;
}

export async function extractObject(file: File): Promise<ExtractResponse> {
  const baseUrl = await getApiBaseUrl();
  const form = new FormData();
  form.append("image", file);
  const response = await safeFetch(`${baseUrl}/objects/extract`, {
    method: "POST",
    body: form,
  });
  return response.json() as Promise<ExtractResponse>;
}

export async function compose(
  request: ComposeRequest,
  signal?: AbortSignal
): Promise<ComposeResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await safeFetch(`${baseUrl}/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return response.json() as Promise<ComposeResponse>;
}

export async function composePreview(
  request: ComposeRequest,
  signal?: AbortSignal
): Promise<PreviewComposeResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await safeFetch(`${baseUrl}/compose/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return response.json() as Promise<PreviewComposeResponse>;
}

// ---------------------------------------------------------------------------
export type ObjectPlacement = components["schemas"]["ObjectPlacement"];
export type HarmonizeRequest = components["schemas"]["HarmonizeRequest"];
export type HarmonizeResponse = components["schemas"]["HarmonizeResponse"];

export async function harmonize(
  request: HarmonizeRequest,
  signal?: AbortSignal
): Promise<HarmonizeResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await safeFetch(`${baseUrl}/compose/harmonize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return response.json() as Promise<HarmonizeResponse>;
}

export async function updateSettings(body: { fal_key?: string }): Promise<void> {
  const baseUrl = await getApiBaseUrl();
  await safeFetch(`${baseUrl}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function postLog(body: LogRequest): Promise<void> {
  const baseUrl = await getApiBaseUrl();
  await safeFetch(`${baseUrl}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type CleanSceneRequest = components["schemas"]["CleanSceneRequest"];
export type CleanSceneResponse = components["schemas"]["CleanSceneResponse"];
export type SegmentPointRequest = components["schemas"]["SegmentPointRequest"];
export type SegmentPointResponse = components["schemas"]["SegmentPointResponse"];

export async function segmentPoint(
  request: SegmentPointRequest,
  signal?: AbortSignal
): Promise<SegmentPointResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await safeFetch(`${baseUrl}/scenes/segment-point`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return response.json() as Promise<SegmentPointResponse>;
}

export async function cleanScene(
  request: CleanSceneRequest,
  signal?: AbortSignal
): Promise<CleanSceneResponse> {
  const baseUrl = await getApiBaseUrl();
  const response = await safeFetch(`${baseUrl}/scenes/clean`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return response.json() as Promise<CleanSceneResponse>;
}
