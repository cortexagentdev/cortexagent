import { env, isProduction } from "../env.ts";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minLevel: Level = isProduction ? "info" : "debug";

export type LogFields = Record<string, unknown>;

const REDACTED = "[redacted]";
const MAX_ERROR_TEXT_LENGTH = 4_000;
const ERROR_METADATA_KEYS = [
  "code",
  "severity",
  "detail",
  "hint",
  "position",
  "routine",
  "constraint",
  "table",
  "column",
] as const;

/** Keep provider diagnostics useful without serializing credentials or payloads. */
function redactSensitiveText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const redacted = value
    // viem includes the complete JSON-RPC payload in this section. Keep the
    // provider's following Details text because it drives adaptive handling.
    .replace(
      /Request body:\s*\{[\s\S]*?\}(?=\s*(?:Details:|URL:|$))/gi,
      `Request body: ${REDACTED}`,
    )
    // postgres-js prefixes its useful error metadata with a generated query.
    // The query can contain every holder address and parameter; the metadata
    // below is serialized separately, so discard the query text here.
    .replace(/Failed query:[\s\S]*/i, `Failed query: ${REDACTED}`)
    // Alchemy and Validation Cloud put credentials in the versioned URL path.
    .replace(
      /(https?):\/\/(robinhood-mainnet\.g\.alchemy\.com|mainnet\.robinhood\.validationcloud\.io)(\/v\d+\/)[^\s"'`<>]+/gi,
      `$1://$2$3${REDACTED}`,
    );

  return redacted.length <= MAX_ERROR_TEXT_LENGTH
    ? redacted
    : `${redacted.slice(0, 1_900)}... [truncated] ...${redacted.slice(-1_900)}`;
}

function serializeError(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: redactSensitiveText(value.stack),
    };
    const source = value as Error & Record<string, unknown>;
    for (const key of ERROR_METADATA_KEYS) {
      const metadata = source[key];
      if (typeof metadata === "string" || typeof metadata === "number") {
        serialized[key] = redactSensitiveText(String(metadata));
      }
    }
    if (depth < 2 && source.cause instanceof Error) {
      serialized.cause = serializeError(source.cause, depth + 1);
    }
    return serialized;
  }
  return value;
}

function emit(level: Level, message: string, fields: LogFields, bindings: LogFields) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const record: LogFields = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...bindings,
    ...fields,
  };
  if ("err" in record) record.err = serializeError(record.err);

  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps every record with the given fields. */
  child(bindings: LogFields): Logger;
}

function makeLogger(bindings: LogFields): Logger {
  return {
    debug: (message, fields = {}) => emit("debug", message, fields, bindings),
    info: (message, fields = {}) => emit("info", message, fields, bindings),
    warn: (message, fields = {}) => emit("warn", message, fields, bindings),
    error: (message, fields = {}) => emit("error", message, fields, bindings),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

export const logger = makeLogger({ service: env.SERVICE_NAME, env: env.NODE_ENV });
