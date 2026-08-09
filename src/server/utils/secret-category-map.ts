import type { SettingsCategory } from '@shared/schemas/settings/registry.js';
import type { SecretEntity } from './secret-codec.js';

// Derive encryption, response-masking, and migration views from one map so they cannot drift.
// AuthService manages auth inline, so it is masked/migrated here but excluded from SettingsService.

type ManagedBy = 'SettingsService' | 'AuthService';

interface SecretCategoryEntry {
  readonly key: string;
  readonly entity: SecretEntity;
  readonly managedBy: ManagedBy;
}

function settingsManaged(key: SettingsCategory, entity: SecretEntity): SecretCategoryEntry {
  return { key, entity, managedBy: 'SettingsService' };
}

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

export const SECRET_CATEGORIES: Partial<Record<SettingsCategory, SecretEntity>> =
  Object.fromEntries(
    SECRET_CATEGORY_MAP
      .filter((e) => e.managedBy === 'SettingsService')
      .map((e) => [e.key, e.entity]),
  ) as Partial<Record<SettingsCategory, SecretEntity>>;

export const SETTINGS_SECRET_MAP: readonly (readonly [string, SecretEntity])[] =
  SECRET_CATEGORY_MAP.map((e) => [e.key, e.entity] as const);

export const SECRET_SETTINGS_CATEGORIES: readonly { key: string; entity: SecretEntity }[] =
  SECRET_CATEGORY_MAP.map((e) => ({ key: e.key, entity: e.entity }));
