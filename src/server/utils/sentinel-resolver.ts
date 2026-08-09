import {
  isSentinel,
  resolveSentinelFields,
  encryptFields,
  getSecretFieldNames,
  getKey,
  SentinelOnNonSecretFieldError,
  type SecretEntity,
} from './secret-codec.js';

// Persist resolves against encrypted rows and re-encrypts; config tests resolve against
// decrypted rows and return plaintext credentials. The two paths are not interchangeable.

/** Resolve against raw stored settings, then encrypt a fresh object. */
export function resolveAndEncryptSettings(
  entity: SecretEntity,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const settings = { ...incoming };
  resolveSentinelFields(settings, existing, getSecretFieldNames(entity));
  return encryptFields(entity, settings, getKey());
}

/** Resolve against decrypted settings and return a fresh plaintext object. */
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
  /** Fetch persisted settings only when resolving a sentinel with an id. */
  loadExisting: () => Promise<Record<string, unknown> | null>;
  notFoundMessage: string;
}

/** Route preflight returning plaintext settings or the exact 400/404 response directive. */
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

  // Retain the catch against future allowlist drift despite the pre-check above.
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
