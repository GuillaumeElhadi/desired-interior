import React from "react";
import { logger } from "../lib/logger";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.error("unhandled_react_error", {
      message: error.message,
      component_stack: info.componentStack ?? "",
    });
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50">
          <h1 className="text-2xl font-semibold text-gray-900">Something went wrong</h1>
          <p className="text-sm text-gray-500">The application encountered an unexpected error.</p>
          {/* Show raw message in dev only; never leak internal paths or API details to end users. */}
          <p
            className="font-mono text-xs text-red-600"
            role="status"
            aria-live="polite"
            data-testid="error-detail"
          >
            {import.meta.env.DEV ? error.message : "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
          >
            Restart
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
