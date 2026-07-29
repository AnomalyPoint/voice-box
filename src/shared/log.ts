import { redactValue } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogSink {
  write(line: string): void;
}

/**
 * The only sink safe to use from the MCP process: stdout carries JSON-RPC
 * frames, so anything written there corrupts the protocol.
 */
export const stderrSink: LogSink = {
  write(line) {
    process.stderr.write(`${line}\n`);
  },
};

export const nullSink: LogSink = { write() {} };

export interface Logger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
  child(scope: string): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  scope?: string;
  level?: LogLevel;
  sink?: LogSink;
}

function resolveLevel(explicit?: LogLevel): LogLevel {
  if (explicit) return explicit;
  const fromEnv = process.env["VOICE_BOX_LOG_LEVEL"]?.trim().toLowerCase();
  if (fromEnv && fromEnv in LEVEL_RANK) return fromEnv as LogLevel;
  return "info";
}

function formatContext(context: unknown): string {
  if (context === undefined) return "";
  const redacted = redactValue(context);
  try {
    return ` ${JSON.stringify(redacted)}`;
  } catch {
    return ` ${String(redacted)}`;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = resolveLevel(options.level);
  const sink = options.sink ?? stderrSink;
  const scope = options.scope ?? "voice-box";
  const threshold = LEVEL_RANK[level];

  const emit = (lineLevel: Exclude<LogLevel, "silent">, message: string, context?: unknown) => {
    if (LEVEL_RANK[lineLevel] < threshold) return;
    const timestamp = new Date().toISOString();
    sink.write(
      `${timestamp} ${lineLevel.padEnd(5)} [${scope}] ${redactValue(message) as string}${formatContext(context)}`,
    );
  };

  return {
    level,
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    child: (childScope) =>
      createLogger({ ...options, level, sink, scope: `${scope}:${childScope}` }),
  };
}
