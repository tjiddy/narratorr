import type { SettingsCategory } from '../../shared/schemas/settings/registry.js';
import type { SecretEntity } from './secret-codec.js';

// ─── Canonical settings-secret category → entity map ─────────────────────────
//
// ONE source of truth for "which settings-blob category carries secrets, under
// which SecretEntity". Three derived views are consumed downstream:
//
//   SECRET_CATEGORIES       → SettingsService encrypt-on-write / decrypt-on-read
//   SETTINGS_SECRET_MAP     → routes/settings.ts mask-on-GET / mask-on-PUT
//   SECRET_SETTINGS_CATEGORIES → secret-migration.ts startup plaintext→encrypted backfill
//
// Before #1567 these were three hand-maintained lists that had to agree and had
// already drifted (a category present in encrypt + mask but missing from the
// migration list). Deriving all three from this one map closes that class of
// drift; the lockstep test (secret-category-map.test.ts) fails if a category is
// added to one view without the others.
//
// `managedBy` encodes the intentional carve-out (don't merge the lists blindly):
//   - SettingsService — written through `SettingsService.set()`; key is a real
//     `SettingsCategory`; encrypted/decrypted by SECRET_CATEGORIES.
//   - AuthService — `auth` is stored as its own DB row and encrypted/decrypted
//     INLINE by that service, NOT through `SettingsService.set()`. Its key is NOT
//     a `SettingsCategory` value, so it is deliberately ABSENT from the
//     encrypt/decrypt view. It stays in the mask + migration views for
//     defense-in-depth.
//
// Latent note: the `auth` entry in the mask view is effectively a no-op against
// the real `GET /api/settings` body — `SettingsService.getAll()` only iterates
// `SETTINGS_CATEGORIES`, and `auth` is not among them. It is kept in the mask
// view for safety (so a future code path that does surface it is masked by
// default), not because it currently appears in the response.

type ManagedBy = 'SettingsService' | 'AuthService';

interface SecretCategoryEntry {
  readonly key: string;
  readonly entity: SecretEntity;
  readonly managedBy: ManagedBy;
}

/**
 * SettingsService-managed entry. The `key` is constrained to `SettingsCategory`
 * so a misspelled category is a compile error and the encrypt/decrypt view stays
 * typed to real category keys.
 */
function settingsManaged(key: SettingsCategory, entity: SecretEntity): SecretCategoryEntry {
  return { key, entity, managedBy: 'SettingsService' };
}

/**
 * Externally-managed entry (`auth`). The `key` stays a plain string — it is NOT a
 * `SettingsCategory` value and is encrypted inline by AuthService, not by
 * `SettingsService.set()`.
 */
function externallyManaged(
  key: string,
  entity: SecretEntity,
  managedBy: 'AuthService',
): SecretCategoryEntry {
  return { key, entity, managedBy };
}

export const SECRET_CATEGORY_MAP: readonly SecretCategoryEntry[] = [
  externallyManaged('auth', 'auth', 'AuthService'),
  settingsManaged('network', 'network'),
  settingsManaged('metadata', 'metadata'),
];

// ─── Derived views ───────────────────────────────────────────────────────────

/**
 * Encrypt-on-write / decrypt-on-read view: only categories managed by
 * SettingsService (`set()`/`get()`/`getAll()`). Excludes auth by design.
 */
export const SECRET_CATEGORIES: Partial<Record<SettingsCategory, SecretEntity>> =
  Object.fromEntries(
    SECRET_CATEGORY_MAP
      .filter((e) => e.managedBy === 'SettingsService')
      .map((e) => [e.key, e.entity]),
  ) as Partial<Record<SettingsCategory, SecretEntity>>;

/** Mask-on-response view: every secret category (used by `maskSettingsResponse`). */
export const SETTINGS_SECRET_MAP: readonly (readonly [string, SecretEntity])[] =
  SECRET_CATEGORY_MAP.map((e) => [e.key, e.entity] as const);

/** Startup migration view: every secret category to backfill plaintext → encrypted. */
export const SECRET_SETTINGS_CATEGORIES: readonly { key: string; entity: SecretEntity }[] =
  SECRET_CATEGORY_MAP.map((e) => ({ key: e.key, entity: e.entity }));
