import { config } from "./config.ts";

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const minLevel = LOG_LEVELS[config.LOG_LEVEL] ?? 1;

function log(level: LogLevel, data: Record<string, unknown> | string, message?: string): void {
  if (LOG_LEVELS[level] < minLevel) return;

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
  };

  if (typeof data === "string") {
    entry.message = data;
  } else {
    Object.assign(entry, data);
    if (message) entry.message = message;
  }

  const output = JSON.stringify(entry);

  if (level === "error" || level === "fatal") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (data: Record<string, unknown> | string, message?: string) => log("debug", data, message),
  info: (data: Record<string, unknown> | string, message?: string) => log("info", data, message),
  warn: (data: Record<string, unknown> | string, message?: string) => log("warn", data, message),
  error: (data: Record<string, unknown> | string, message?: string) => log("error", data, message),
  fatal: (data: Record<string, unknown> | string, message?: string) => log("fatal", data, message),
};
