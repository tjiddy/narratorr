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
 * hand-maintained homes that had to agree and had already drifted (`earwitness`
 * was absent from the migration list — see #1526). All three are now derived
 * from `SECRET_CATEGORY_MAP`; these tests fail if a category is added to one
 * derived view without the others, or if the prowlarr/auth carve-out regresses.
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
      // Regression of the #1526 bug (earwitness absent from migration) fails here.
      for (const key of encryptKeys) {
        expect(migrateKeys.has(key)).toBe(true);
      }
    });

    it('earwitness is consistently covered across encrypt, mask, and migrate', () => {
      expect(encryptKeys).toContain('earwitness');
      expect(maskKeys.has('earwitness')).toBe(true);
      expect(migrateKeys.has('earwitness')).toBe(true);
    });
  });

  describe('prowlarr/auth carve-out preserved', () => {
    it('prowlarr and auth are present in the mask and migration views', () => {
      for (const key of ['prowlarr', 'auth']) {
        expect(maskKeys.has(key)).toBe(true);
        expect(migrateKeys.has(key)).toBe(true);
      }
    });

    it('prowlarr and auth are absent from the encrypt/decrypt view', () => {
      // They are encrypted inline by Auth/Indexer services, not SettingsService.set().
      expect(encryptKeys).not.toContain('prowlarr');
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
