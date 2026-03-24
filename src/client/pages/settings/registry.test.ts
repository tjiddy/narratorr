import { describe, it, expect } from 'vitest';
import { settingsPageRegistry } from './registry';

describe('settingsPageRegistry', () => {
  it('exports an array with all 9 settings page entries', () => {
    expect(settingsPageRegistry).toHaveLength(9);
  });

  it('each entry has path, label, icon, and component', () => {
    for (const entry of settingsPageRegistry) {
      expect(typeof entry.path).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.icon).toBe('function');
      expect(typeof entry.component).toBe('function');
    }
  });

  it('General entry has end: true', () => {
    const general = settingsPageRegistry.find((e) => e.label === 'General');
    expect(general).toBeDefined();
    expect(general!.end).toBe(true);
  });

  it('non-General entries do not have end: true', () => {
    const nonGeneral = settingsPageRegistry.filter((e) => e.label !== 'General');
    expect(nonGeneral.length).toBe(8);
    for (const entry of nonGeneral) {
      expect(entry.end).toBeUndefined();
    }
  });

  it('Import Lists entry is present (regression guard)', () => {
    const importLists = settingsPageRegistry.find((e) => e.label === 'Import Lists');
    expect(importLists).toBeDefined();
    expect(importLists!.path).toBe('import-lists');
  });

  it('paths match expected settings route paths', () => {
    const paths = settingsPageRegistry.map((e) => e.path);
    expect(paths).toEqual([
      '',
      'post-processing',
      'indexers',
      'download-clients',
      'notifications',
      'blacklist',
      'security',
      'import-lists',
      'system',
    ]);
  });

  it('Post Processing entry is present at index 1', () => {
    const entry = settingsPageRegistry.find((e) => e.label === 'Post Processing');
    expect(entry).toBeDefined();
    expect(entry!.path).toBe('post-processing');
    expect(entry!.end).toBeUndefined();
  });
});
