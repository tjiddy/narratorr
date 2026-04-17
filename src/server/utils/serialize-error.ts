/** Serialized error shape safe for Pino JSON logging. */
export interface SerializedError {
  message: string;
  stack?: string;
  type: string;
  cause?: SerializedError;
}

const MAX_CAUSE_DEPTH = 5;

/**
 * Serializes an unknown caught value into a Pino-safe object.
 *
 * Pino's built-in serializers only handle the `err` key with actual Error instances.
 * TypeScript `catch (error: unknown)` bindings logged as `{ error }` produce `"error":{}`
 * in JSON output. This helper extracts message, stack, type, and cause chain so the
 * information is preserved in structured logs.
 */
export function serializeError(err: unknown): SerializedError {
  try {
    return serialize(err, new Set([err]), 0);
  } catch {
    // Never-throw guarantee: if serialization itself fails, return a minimal result
    return { message: String(err), type: typeof err };
  }
}

function serialize(err: unknown, seen: Set<unknown>, depth: number): SerializedError {
  if (!(err instanceof Error)) {
    return { message: String(err), type: typeof err };
  }

  const result: SerializedError = {
    message: err.message,
    stack: err.stack,
    type: err.constructor.name,
  };

  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH && !seen.has(err.cause)) {
    seen.add(err.cause);
    result.cause = serialize(err.cause, seen, depth + 1);
  }

  return result;
}
