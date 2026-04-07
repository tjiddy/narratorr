import { describe, it, expect } from 'vitest';
import {
  detectLanguageFromNewsgroup,
  parseNzbGroups,
} from './detect-usenet-language.js';

describe('detectLanguageFromNewsgroup', () => {
  describe('token-to-language mapping', () => {
    it('maps "german" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.german')).toBe('german');
    });

    it('maps "hoerbuecher" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.sounds.mp3.german.hoerbuecher')).toBe('german');
    });

    it('maps "hoerspiele" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.hoerspiele')).toBe('german');
    });

    it('maps "deutsch" token to "german"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.deutsch')).toBe('german');
    });

    it('maps "french" token to "french"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.french')).toBe('french');
    });

    it('maps "francais" token to "french"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.francais')).toBe('french');
    });

    it('maps "dutch" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.dutch')).toBe('dutch');
    });

    it('maps "nederlands" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.nederlands')).toBe('dutch');
    });

    it('maps "audioboeken" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.audioboeken')).toBe('dutch');
    });

    it('maps "luisterboeken" token to "dutch"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.luisterboeken')).toBe('dutch');
    });

    it('maps "spanish" token to "spanish"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.spanish')).toBe('spanish');
    });

    it('maps "italian" token to "italian"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.italian')).toBe('italian');
    });

    it('maps "italiano" token to "italian"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.italiano')).toBe('italian');
    });

    it('maps "japanese" token to "japanese"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.japanese')).toBe('japanese');
    });

    it('maps "nihongo" token to "japanese"', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.nihongo')).toBe('japanese');
    });
  });

  describe('group name parsing', () => {
    it('returns undefined for unknown tokens like mp3, audiobooks, sounds, binaries', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.sounds.mp3.audiobooks')).toBeUndefined();
    });

    it('first language-specific token wins when group contains multiple (alt.binaries.german.french → german)', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.german.french')).toBe('german');
    });

    it('returns undefined for empty string input', () => {
      expect(detectLanguageFromNewsgroup('')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(detectLanguageFromNewsgroup(undefined)).toBeUndefined();
    });

    it('matches tokens case-insensitively (GERMAN, German, german all resolve)', () => {
      expect(detectLanguageFromNewsgroup('alt.binaries.GERMAN')).toBe('german');
      expect(detectLanguageFromNewsgroup('alt.binaries.German')).toBe('german');
      expect(detectLanguageFromNewsgroup('alt.binaries.german')).toBe('german');
    });

    it('returns undefined for group with only dots (e.g., "...")', () => {
      expect(detectLanguageFromNewsgroup('...')).toBeUndefined();
    });

    it('detects language from single token input (e.g., just "german")', () => {
      expect(detectLanguageFromNewsgroup('german')).toBe('german');
    });
  });
});

describe('parseNzbGroups', () => {
  it('extracts single group tag from NZB XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test@example.com" date="1234567890" subject="test">
    <groups><group>alt.binaries.german.hoerbuecher</group></groups>
    <segments><segment bytes="100" number="1">test@example.com</segment></segments>
  </file>
</nzb>`;
    expect(parseNzbGroups(xml)).toEqual(['alt.binaries.german.hoerbuecher']);
  });

  it('extracts multiple group tags from NZB XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test" date="123" subject="test">
    <groups>
      <group>alt.binaries.german.hoerbuecher</group>
      <group>alt.binaries.sounds.mp3</group>
    </groups>
    <segments><segment bytes="100" number="1">id@example</segment></segments>
  </file>
</nzb>`;
    const groups = parseNzbGroups(xml);
    expect(groups).toContain('alt.binaries.german.hoerbuecher');
    expect(groups).toContain('alt.binaries.sounds.mp3');
  });

  it('returns empty array for NZB with no group tags', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test" date="123" subject="test">
    <segments><segment bytes="100" number="1">id@example</segment></segments>
  </file>
</nzb>`;
    expect(parseNzbGroups(xml)).toEqual([]);
  });

  it('returns empty array for malformed XML', () => {
    expect(parseNzbGroups('not xml at all <><><')).toEqual([]);
  });

  it('skips empty group tags (no text content)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test" date="123" subject="test">
    <groups>
      <group></group>
      <group>alt.binaries.german.hoerbuecher</group>
    </groups>
    <segments><segment bytes="100" number="1">id@example</segment></segments>
  </file>
</nzb>`;
    expect(parseNzbGroups(xml)).toEqual(['alt.binaries.german.hoerbuecher']);
  });
});
