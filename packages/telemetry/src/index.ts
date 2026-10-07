import { randomUUID } from "node:crypto";

// ─── Structured logger ───
// Never logs PII, secrets, tokens, or full page content.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  traceId?: string;
  organizationId?: string;
  projectId?: string;
  jobType?: string;
  ruleVersion?: string;
  costUnits?: number;
  retryCount?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  organizationId?: string;
  projectId?: string;
  context: LogContext;
}

function formatLog(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function log(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    traceId: context.traceId,
    organizationId: context.organizationId,
    projectId: context.projectId,
    context,
  };

  const formatted = formatLog(entry);

  switch (level) {
    case "error":
      process.stderr.write(formatted + "\n");
      break;
    default:
      process.stdout.write(formatted + "\n");
  }
}

export const logger = {
  debug: (message: string, context?: LogContext): void => {
    log("debug", message, context);
  },
  info: (message: string, context?: LogContext): void => {
    log("info", message, context);
  },
  warn: (message: string, context?: LogContext): void => {
    log("warn", message, context);
  },
  error: (message: string, context?: LogContext): void => {
    log("error", message, context);
  },
};

// ─── Trace ID generation ───
export function generateTraceId(): string {
  return randomUUID();
}

// ─── Job context ───
export interface JobContext {
  traceId: string;
  organizationId: string;
  projectId: string;
  jobType: string;
}

export function createJobContext(params: Omit<JobContext, "traceId">): JobContext {
  return {
    traceId: generateTraceId(),
    ...params,
  };
}

// ─── Sanitize secrets ───
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /sk_(?:live|test)_[A-Za-z0-9]+/g,
  /ya29\.[A-Za-z0-9\-_]+/g,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
];

export function sanitizeSecrets(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}
