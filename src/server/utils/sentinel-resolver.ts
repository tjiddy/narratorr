import {
  isSentinel,
  resolveSentinelFields,
  getSecretFieldNames,
  SentinelOnNonSecretFieldError,
  type SecretEntity,
} from './secret-codec.js';

export type SentinelResolution =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; status: 400 | 404; message: string };

export interface ResolveSentinelArgs {
  entity: SecretEntity;
  incoming: Record<string, unknown>;
  id: number | undefined;
  /** Lazily fetches the persisted record's settings. Only invoked when a
   *  secret-field sentinel is present and an id was provided. */
  loadExisting: () => Promise<Record<string, unknown> | null>;
  notFoundMessage: string;
}

/**
 * Route-side sentinel preflight. Detects sentinel values in `incoming`,
 * rejects sentinels on non-secret keys, and resolves secret-field sentinels
 * against the persisted record. Returns the merged plaintext settings, or a
 * `{ ok: false, status, message }` directive the route handler should emit.
 *
 * Status mapping matches the AC for the masked-credential routes:
 *   - sentinel on non-secret field        → 400
 *   - sentinel on secret field, no id     → 400
 *   - sentinel on secret field, unknown id → 404
 *   - no sentinels                        → returns incoming unchanged
 */
export async function resolveSentinelSettings(
  args: ResolveSentinelArgs,
): Promise<SentinelResolution> {
  const { entity, incoming, id, loadExisting, notFoundMessage } = args;
  const allowlist = getSecretFieldNames(entity);

  const sentinelKeys: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === 'string' && isSentinel(value)) sentinelKeys.push(key);
  }

  if (sentinelKeys.length === 0) return { ok: true, settings: incoming };

  const nonSecret = sentinelKeys.find((k) => !allowlist.includes(k));
  if (nonSecret) {
    return {
      ok: false,
      status: 400,
      message: `Sentinel value is not allowed on non-secret field: ${nonSecret}`,
    };
  }

  if (id == null) {
    return {
      ok: false,
      status: 400,
      message: 'id is required to resolve masked field values',
    };
  }

  const existing = await loadExisting();
  if (!existing) {
    return { ok: false, status: 404, message: notFoundMessage };
  }

  try {
    const resolved = { ...incoming };
    resolveSentinelFields(resolved, existing, allowlist);
    return { ok: true, settings: resolved };
  } catch (e) {
    if (e instanceof SentinelOnNonSecretFieldError) {
      return { ok: false, status: 400, message: e.message };
    }
    throw e;
  }
}
