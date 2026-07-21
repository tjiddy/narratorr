import { describe, it, expect } from 'vitest';
import { basename } from 'node:path';
import { deriveImportSiblings } from './import-sibling-paths.js';

/**
 * #1911 — the ONE shared server-side helper that maps an import target to its transient
 * siblings. The active scratch is born-hidden and INJECTIVE (a single unconditional leading
 * dot, NOT the idempotent `dotPrefixBasename`); the legacy fields are recognition-only.
 */
describe('deriveImportSiblings (#1911)', () => {
  // Composed with `node:path`; normalize backslashes for the cross-platform rule.
  const norm = (p: string): string => p.split('\\').join('/');

  it('maps a visible target to dot-led active scratch + un-dotted legacy scratch + marker', () => {
    const s = deriveImportSiblings('/lib/Author/Title');
    expect(norm(s.stagingPath)).toBe('/lib/Author/.Title.import-staging');
    expect(norm(s.backupPath)).toBe('/lib/Author/.Title.import-backup');
    expect(norm(s.legacyStagingPath)).toBe('/lib/Author/Title.import-tmp');
    expect(norm(s.legacyBackupPath)).toBe('/lib/Author/Title.import-bak');
    expect(norm(s.markerPath)).toBe('/lib/Author/Title.import-commit-pending');
  });

  it('is INJECTIVE on the target basename — a dot-led target gets a distinct double-dot name', () => {
    const visible = deriveImportSiblings('/lib/Author/Title');
    const hidden = deriveImportSiblings('/lib/Author/.Title');
    expect(norm(hidden.stagingPath)).toBe('/lib/Author/..Title.import-staging');
    expect(norm(hidden.backupPath)).toBe('/lib/Author/..Title.import-backup');
    // Distinct from the visible target's scratch — the idempotent dot-prefix would collapse these.
    expect(hidden.stagingPath).not.toBe(visible.stagingPath);
    expect(hidden.backupPath).not.toBe(visible.backupPath);
    // Each dot-led target keeps its OWN distinct marker on the (un-dotted) target basename.
    expect(norm(hidden.markerPath)).toBe('/lib/Author/.Title.import-commit-pending');
    expect(hidden.markerPath).not.toBe(visible.markerPath);
  });

  it('the active-basename inverse (strip suffix + one leading dot) recovers the exact target basename', () => {
    for (const target of ['/lib/Author/Title', '/lib/Author/.Title', '/lib/Author/.hack__Sign']) {
      const { stagingPath } = deriveImportSiblings(target);
      const recovered = basename(stagingPath).slice(1, -'.import-staging'.length); // drop one dot + suffix
      expect(recovered).toBe(basename(target));
    }
  });

  it('handles a bare basename with no directory component', () => {
    const s = deriveImportSiblings('Title');
    expect(s.stagingPath).toBe('.Title.import-staging');
    expect(s.legacyStagingPath).toBe('Title.import-tmp');
  });

  it('ABS-parity: both active basenames (and a file inside them) are dot-led → ABS-ignored', () => {
    // Mirror of ABS `shouldIgnoreFile`: ignored when the basename or any path component is dot-led.
    const absShouldIgnore = (relPath: string): boolean => relPath.split('/').some((seg) => seg.startsWith('.'));
    const { stagingPath, backupPath } = deriveImportSiblings('/lib/Author/Title');
    for (const name of [basename(stagingPath), basename(backupPath)]) {
      expect(name.startsWith('.')).toBe(true);
      expect(absShouldIgnore(name)).toBe(true);
      expect(absShouldIgnore(`${name}/06 - track.mp3`)).toBe(true);
    }
  });
});
