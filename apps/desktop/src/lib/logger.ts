import { postLog } from "./api";
import type { LogEntry } from "./api";

// One UUID per app session — used to correlate frontend log entries in backend logs.
export const correlationId: string = crypto.randomUUID();

type LogLevel = LogEntry["level"];
type LogContext = Record<string, unknown>;

async function ship(level: LogLevel, message: string, context: LogContext): Promise<void> {
  try {
    await postLog({
      entries: [
        {
          level,
          message,
          correlation_id: correlationId,
          timestamp: new Date().toISOString(),
          context,
        },
      ],
    });
  } catch {
    // Logging failures must never affect the app.
  }
}

function makeEntry(level: LogLevel) {
  return (message: string, context: LogContext = {}): void => {
    if (level === "error") {
      console.error(`[${level.toUpperCase()}] ${message}`, context);
    } else if (level === "warn") {
      console.warn(`[${level.toUpperCase()}] ${message}`, context);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`, context);
    }
    void ship(level, message, context);
  };
}

export const logger = {
  debug: makeEntry("debug"),
  info: makeEntry("info"),
  warn: makeEntry("warn"),
  error: makeEntry("error"),
};
