import { describe, it, expect } from 'vitest';
import { SETTINGS_CATEGORIES } from '../../shared/schemas.js';
import { getSecretFieldNames } from './secret-codec.js';
import {
  SECRET_CATEGORY_MAP,
  SECRET_CATEGORIES,
  SETTINGS_SECRET_MAP,
  SECRET_SETTINGS_CATEGORIES,
} from './secret-category-map.js';

/**
 * #1567 — lockstep guard over the canonical settings-secret category map.
 *
 * Before this, the encrypt/decrypt, mask, and migration lists were three
 * hand-maintained homes that had to agree and had already drifted (a category
 * absent from the migration list while present in encrypt + mask). All three are
 * now derived from `SECRET_CATEGORY_MAP`; these tests fail if a category is added
 * to one derived view without the others, or if the auth carve-out regresses.
 */

// Mirror of the route's mask view as a plain category set.
const maskKeys = new Set(SETTINGS_SECRET_MAP.map(([key]) => key));
// Mirror of the migration view as a plain category set.
const migrateKeys = new Set(SECRET_SETTINGS_CATEGORIES.map((c) => c.key));
// Encrypt-on-write categories (SettingsService-managed).
const encryptKeys = Object.keys(SECRET_CATEGORIES);

describe('#1567 settings-secret canonical map', () => {
  describe('three derived views agree', () => {
    it('every encrypt-on-write category is also masked on response', () => {
      for (const key of encryptKeys) {
        expect(maskKeys.has(key)).toBe(true);
      }
    });

    it('every encrypt-on-write category is also covered by the startup migration', () => {
      for (const key of encryptKeys) {
        expect(migrateKeys.has(key)).toBe(true);
      }
    });
  });

  describe('auth carve-out preserved', () => {
    it('auth is present in the mask and migration views', () => {
      expect(maskKeys.has('auth')).toBe(true);
      expect(migrateKeys.has('auth')).toBe(true);
    });

    it('auth is absent from the encrypt/decrypt view', () => {
      // It is encrypted inline by AuthService, not SettingsService.set().
      expect(encryptKeys).not.toContain('auth');
    });

    it('the encrypt/decrypt view contains only valid SettingsCategory keys', () => {
      const valid = new Set<string>(SETTINGS_CATEGORIES);
      for (const key of encryptKeys) {
        expect(valid.has(key)).toBe(true);
      }
    });

    it('SettingsService-managed entries are exactly the encrypt/decrypt view', () => {
      const managed = SECRET_CATEGORY_MAP
        .filter((e) => e.managedBy === 'SettingsService')
        .map((e) => e.key);
      expect(new Set(managed)).toEqual(new Set(encryptKeys));
    });
  });

  describe('no orphan entities', () => {
    it('every SecretEntity in the canonical map has a non-empty SECRET_FIELDS entry', () => {
      for (const { entity } of SECRET_CATEGORY_MAP) {
        expect(getSecretFieldNames(entity).length).toBeGreaterThan(0);
      }
    });
  });
});
