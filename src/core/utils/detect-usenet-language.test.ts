import { describe, it, expect } from 'vitest';
import {
  detectLanguageFromNewsgroup,
  parseNzbGroups,
  parseNzbName,
  parseNzbFileSubject,
  detectLanguageFromNzbName,
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

describe('parseNzbName', () => {
  it('extracts name from <meta type="name">content</meta> tag', () => {
    const xml = `<nzb><head><meta type="name">Stephen King-Hörbuch-Pack.part01.rar</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Stephen King-Hörbuch-Pack.part01.rar');
  });

  it('returns undefined when <meta type="name"> is absent', () => {
    const xml = `<nzb><head><meta type="password">secret</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBeUndefined();
  });

  it('returns undefined for empty <meta type="name"></meta>', () => {
    const xml = `<nzb><head><meta type="name"></meta></head></nzb>`;
    expect(parseNzbName(xml)).toBeUndefined();
  });

  it('handles HTML entities in name content (&quot;, &amp;, &lt;, &gt;)', () => {
    const xml = `<nzb><head><meta type="name">(02/12) Description &quot;Stephen King&amp;Pack.rar&quot; - 28,76 GB</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('(02/12) Description "Stephen King&Pack.rar" - 28,76 GB');
  });

  it('case-insensitive match on type="name" attribute', () => {
    const xml = `<nzb><head><meta type="NAME">Test Name</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Test Name');
  });

  it('uses first match when multiple <meta type="name"> tags present', () => {
    const xml = `<nzb><head><meta type="name">First</meta><meta type="name">Second</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('First');
  });

  it('returns undefined for malformed XML', () => {
    expect(parseNzbName('not xml <><><')).toBeUndefined();
  });

  it('returns undefined for whitespace-only content', () => {
    const xml = `<nzb><head><meta type="name">   </meta></head></nzb>`;
    expect(parseNzbName(xml)).toBeUndefined();
  });

  it('decodes decimal numeric character references', () => {
    const xml = `<nzb><head><meta type="name">H&#246;rbuch</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Hörbuch');
  });

  it('decodes hex numeric character references (lowercase x)', () => {
    const xml = `<nzb><head><meta type="name">H&#xF6;rbuch</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Hörbuch');
  });

  it('decodes hex numeric character references (uppercase X)', () => {
    const xml = `<nzb><head><meta type="name">H&#XF6;rbuch</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Hörbuch');
  });

  it('decodes mixed numeric and named entities in same string', () => {
    const xml = `<nzb><head><meta type="name">H&#246;rbuch &amp; Friends</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Hörbuch & Friends');
  });

  it('decodes decimal numeric refs with leading zeros', () => {
    const xml = `<nzb><head><meta type="name">H&#0246;rbuch</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Hörbuch');
  });

  it('preserves invalid hex numeric refs (e.g. &#xZZ;) unchanged', () => {
    const xml = `<nzb><head><meta type="name">Bad &#xZZ; value</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Bad &#xZZ; value');
  });

  it('preserves out-of-range decimal code points (> U+10FFFF) unchanged', () => {
    const xml = `<nzb><head><meta type="name">Bad &#99999999; value</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Bad &#99999999; value');
  });

  it('preserves out-of-range hex code points (> U+10FFFF) unchanged', () => {
    const xml = `<nzb><head><meta type="name">Bad &#x110000; value</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Bad &#x110000; value');
  });

  it('preserves lone high-surrogate code points (U+D800) unchanged', () => {
    const xml = `<nzb><head><meta type="name">Bad &#xD800; value</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Bad &#xD800; value');
  });

  it('preserves lone low-surrogate code points (U+DFFF) unchanged', () => {
    const xml = `<nzb><head><meta type="name">Bad &#xDFFF; value</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('Bad &#xDFFF; value');
  });

  it('does NOT cascade numeric decoding through pre-encoded &amp; (&amp;#246; → &#246;, not ö)', () => {
    const xml = `<nzb><head><meta type="name">&amp;#246;</meta></head></nzb>`;
    expect(parseNzbName(xml)).toBe('&#246;');
  });
});

describe('parseNzbFileSubject', () => {
  it('extracts subject from first <file subject="..."> attribute', () => {
    const xml = `<nzb><file poster="test" date="123" subject="Stephen King-Pack.part01.rar"><segments></segments></file></nzb>`;
    expect(parseNzbFileSubject(xml)).toBe('Stephen King-Pack.part01.rar');
  });

  it('returns undefined when no <file> elements exist', () => {
    const xml = `<nzb><head></head></nzb>`;
    expect(parseNzbFileSubject(xml)).toBeUndefined();
  });

  it('returns undefined for empty subject attribute', () => {
    const xml = `<nzb><file poster="test" date="123" subject=""><segments></segments></file></nzb>`;
    expect(parseNzbFileSubject(xml)).toBeUndefined();
  });

  it('handles HTML entities in subject attribute value', () => {
    const xml = `<nzb><file poster="test" date="123" subject="Book &amp; Series"><segments></segments></file></nzb>`;
    expect(parseNzbFileSubject(xml)).toBe('Book & Series');
  });

  it('decodes decimal numeric character references in subject attribute', () => {
    const xml = `<nzb><file poster="test" date="123" subject="Ungek&#252;rzt"><segments></segments></file></nzb>`;
    expect(parseNzbFileSubject(xml)).toBe('Ungekürzt');
  });

  it('decodes hex numeric character references in subject attribute', () => {
    const xml = `<nzb><file poster="test" date="123" subject="Ungek&#xFC;rzt"><segments></segments></file></nzb>`;
    expect(parseNzbFileSubject(xml)).toBe('Ungekürzt');
  });

  it('returns undefined for malformed XML', () => {
    expect(parseNzbFileSubject('not xml at all')).toBeUndefined();
  });
});

describe('detectLanguageFromNzbName', () => {
  it('detects hörbuch (with umlaut) as german', () => {
    expect(detectLanguageFromNzbName('Stephen King-Hörbuch-Pack.rar')).toBe('german');
  });

  it('detects horbuch (ASCII approximation) as german', () => {
    expect(detectLanguageFromNzbName('Stephen King-Horbuch-Pack.rar')).toBe('german');
  });

  it('detects h?rbuch (question-mark mangled umlaut) as german', () => {
    expect(detectLanguageFromNzbName('Stephen King-H?rbuch-Pack.rar')).toBe('german');
  });

  it('detects hörbücher and horbucher as german', () => {
    expect(detectLanguageFromNzbName('Sammlung Hörbücher 2024')).toBe('german');
    expect(detectLanguageFromNzbName('Sammlung Horbucher 2024')).toBe('german');
  });

  it('detects ungekürzt (proper UTF-8) as german', () => {
    expect(detectLanguageFromNzbName('Stephen King — Fairy Tale (Ungekürzt)')).toBe('german');
  });

  it('detects ungekuerzt (German "ue" digraph fallback) as german', () => {
    expect(detectLanguageFromNzbName('Stephen King — Fairy Tale (Ungekuerzt)')).toBe('german');
  });

  it('detects ungekrzt (naked-drop, NZBgeek-stripped form) as german — Fairy Tale UAT case', () => {
    expect(detectLanguageFromNzbName('Stephen.King-Fairy.Tale.(Ungekrzt)')).toBe('german');
  });

  it('detects gekürzt and its mangled forms as german', () => {
    expect(detectLanguageFromNzbName('Some Title (Gekürzt)')).toBe('german');
    expect(detectLanguageFromNzbName('Some Title (Gekuerzt)')).toBe('german');
    expect(detectLanguageFromNzbName('Some Title (Gekrzt)')).toBe('german');
  });

  it('detects luisterboek as dutch', () => {
    expect(detectLanguageFromNzbName('Boek Luisterboek NL.rar')).toBe('dutch');
  });

  it('returns undefined for NZB names with no language tokens', () => {
    expect(detectLanguageFromNzbName('Stephen King - The Stand (2012) MP3')).toBeUndefined();
  });

  it('token matching is case-insensitive', () => {
    expect(detectLanguageFromNzbName('HÖRBUCH Pack')).toBe('german');
    expect(detectLanguageFromNzbName('hörbuch pack')).toBe('german');
  });

  it('returns undefined for undefined input', () => {
    expect(detectLanguageFromNzbName(undefined)).toBeUndefined();
  });
});
