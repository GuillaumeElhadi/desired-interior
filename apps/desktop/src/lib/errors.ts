import { ApiError } from "./api";

export interface UserMessage {
  title: string;
  detail: string;
  /** Which primary CTA the UI should offer. */
  cta: "retry" | "settings" | "reload" | "wait" | "none";
}

export function toUserMessage(err: unknown): UserMessage {
  if (!(err instanceof ApiError)) {
    return {
      title: "Unexpected error",
      detail: "Something went wrong. Please try again.",
      cta: "retry",
    };
  }

  switch (err.errorCode) {
    case "offline":
      return {
        title: "No internet connection",
        detail: "Check your network and try again.",
        cta: "retry",
      };
    case "sidecar_unreachable":
      return {
        title: "API unavailable",
        detail: "The background service stopped. Reload the app to restart it.",
        cta: "reload",
      };
    case "fal_key_missing":
      return {
        title: "API key not configured",
        detail: "Add your fal.ai API key in Settings before rendering.",
        cta: "settings",
      };
    case "fal_rate_limited":
    case "rate_limited":
      return {
        title: "Rate limit reached",
        detail: "Too many requests. Wait a moment and try again.",
        cta: "wait",
      };
    case "fal_timeout":
    case "gateway_timeout":
      return {
        title: "Request timed out",
        detail: "The render took too long. Try again.",
        cta: "retry",
      };
    case "fal_error":
    case "bad_gateway":
      return {
        title: "Render service error",
        detail: "fal.ai returned an error. Try again in a moment.",
        cta: "retry",
      };
    case "scene_not_found":
    case "object_not_found":
      return {
        title: "Data not found",
        detail: "Re-upload the image and try again.",
        cta: "reload",
      };
    case "scene_original_missing":
      return {
        title: "Scene data missing",
        detail: "Re-upload the room photo to refresh the cache.",
        cta: "reload",
      };
    case "unsupported_media_type":
      return {
        title: "Unsupported file type",
        detail: "Please upload a JPEG, PNG, WEBP, or HEIC image.",
        cta: "none",
      };
    case "unauthorized":
      return {
        title: "Authentication error",
        detail: "IPC token mismatch — restart the app.",
        cta: "reload",
      };
    case "service_unavailable":
      return {
        title: "Service unavailable",
        detail: "fal.ai is temporarily unavailable. Try again shortly.",
        cta: "retry",
      };
    default:
      return {
        title: "Something went wrong",
        detail: "An unexpected error occurred. Please try again.",
        cta: "retry",
      };
  }
}
