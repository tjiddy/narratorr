import {
  isSentinel,
  resolveSentinelFields,
  encryptFields,
  getSecretFieldNames,
  getKey,
  SentinelOnNonSecretFieldError,
  type SecretEntity,
} from './secret-codec.js';

// ─── Service-side sentinel helpers (#844) ────────────────────────────────────
//
// The #844 invariant — sentinel placeholders for secret fields resolve only
// against an entity's own secret-field allowlist, and a sentinel on a non-secret
// key is rejected (`SentinelOnNonSecretFieldError`) — lives here, once, for the
// service layer. Every entity service (connector, download-client, import-list,
// indexer, notifier) and `settings.service` delegates to one of the two helpers
// below rather than re-implementing the recipe inline.
//
// The two helpers are NOT interchangeable — they differ in the source of
// `existing` and in whether encryption follows:
//   • Persist path (`update`/`set`): `existing` is the RAW, still-encrypted row
//     read via `db.select()`. `resolveAndEncryptSettings` resolves then encrypts;
//     because `encryptFields` skips `$ENC$`-prefixed values, a sentinel that
//     resolved to a stored secret keeps its exact stored bytes.
//   • Test/config path (`testConfig`/`adapterForConfig`): `existing` is the
//     DECRYPTED row from `getById`. `resolveSettings` resolves to real plaintext
//     and does NOT encrypt — the adapter connection test needs live credentials.
// Encrypting on the test path would hand the adapter ciphertext and break the
// live test, so the split is deliberate; do not collapse the two.
//
// Both helpers own the clone (they spread `incoming` internally), so callers do
// not need to pre-spread. `resolveSentinelFields`/`encryptFields` tolerate a
// null/undefined `existing` (an absent secret resolves to `undefined`).

/**
 * Persist-path helper: resolve secret-field sentinels in `incoming` against the
 * RAW (encrypted) `existing` settings, then encrypt. Returns a fresh object;
 * `incoming` is not mutated. Throws `SentinelOnNonSecretFieldError` for a
 * sentinel on a non-secret key.
 */
export function resolveAndEncryptSettings(
  entity: SecretEntity,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const settings = { ...incoming };
  resolveSentinelFields(settings, existing, getSecretFieldNames(entity));
  return encryptFields(entity, settings, getKey());
}

/**
 * Test/config-path helper: resolve secret-field sentinels in `incoming` against
 * the DECRYPTED `existing` settings and return the plaintext result WITHOUT
 * encrypting. Returns a fresh object; `incoming` is not mutated. Throws
 * `SentinelOnNonSecretFieldError` for a sentinel on a non-secret key.
 */
export function resolveSettings(
  entity: SecretEntity,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const settings = { ...incoming };
  resolveSentinelFields(settings, existing, getSecretFieldNames(entity));
  return settings;
}

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

  // Belt-and-suspenders: the non-secret pre-check at L48-55 already filters
  // sentinels on disallowed keys, so resolveSentinelFields shouldn't throw
  // SentinelOnNonSecretFieldError here. Catch is retained in case a future
  // change to existing-record shape (or allowlist drift between getSecretFieldNames
  // and resolveSentinelFields) reintroduces the throw path.
  try {
    const resolved = { ...incoming };
    resolveSentinelFields(resolved, existing, allowlist);
    return { ok: true, settings: resolved };
  } catch (error: unknown) {
    if (error instanceof SentinelOnNonSecretFieldError) {
      return { ok: false, status: 400, message: error.message };
    }
    throw error;
  }
}
