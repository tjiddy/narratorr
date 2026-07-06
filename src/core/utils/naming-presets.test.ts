import { describe, it, expect } from 'vitest';
import { NAMING_PRESETS, detectPreset } from './naming-presets.js';
import { renderTemplate, renderFilename } from './naming.js';

describe('NAMING_PRESETS', () => {
  it('has exactly 5 presets', () => {
    expect(NAMING_PRESETS).toHaveLength(5);
  });

  it('contains Standard preset with correct formats', () => {
    const preset = NAMING_PRESETS.find(p => p.id === 'standard');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Standard');
    expect(preset!.folderFormat).toBe('{author}/{title}');
    expect(preset!.fileFormat).toBe('{author} - {title}');
  });

  it('contains Detailed preset with correct formats', () => {
    const preset = NAMING_PRESETS.find(p => p.id === 'detailed');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Detailed');
    expect(preset!.folderFormat).toBe('{author}/{series}/{seriesPosition:00? - }{title}');
    expect(preset!.fileFormat).toBe('{author} - {series? - }{seriesPosition:00? - }{title}{ (?edition?)}{ - ?trackNumber:000}');
  });

  it('contains Audiobookshelf preset with correct formats', () => {
    const preset = NAMING_PRESETS.find(p => p.id === 'audiobookshelf');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Audiobookshelf');
    expect(preset!.folderFormat).toBe('{author}/{series?/}{title}');
    expect(preset!.fileFormat).toBe('{title}');
  });

  it('contains Plex preset with correct formats', () => {
    const preset = NAMING_PRESETS.find(p => p.id === 'plex');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Plex');
    expect(preset!.folderFormat).toBe('{author}/{series?/}{year? - }{title}');
    expect(preset!.fileFormat).toBe('{title}{ - pt?trackNumber:00}');
  });

  it('contains "Last, First" preset with correct formats', () => {
    const preset = NAMING_PRESETS.find(p => p.id === 'last-first');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Last, First');
    expect(preset!.folderFormat).toBe('{authorLastFirst}/{titleSort}');
    expect(preset!.fileFormat).toBe('{authorLastFirst} - {titleSort}');
  });
});

describe('preset template validity', () => {
  const sampleTokens = {
    author: 'Brandon Sanderson', authorLastFirst: 'Sanderson, Brandon',
    title: 'The Way of Kings', titleSort: 'Way of Kings',
    series: 'The Stormlight Archive', seriesPosition: 1, year: '2010',
    narrator: 'Michael Kramer', narratorLastFirst: 'Kramer, Michael',
    trackNumber: 1, trackTotal: 12, partName: 'Chapter 1',
  };

  it('all preset folderFormats render without literal brace artifacts', () => {
    for (const preset of NAMING_PRESETS) {
      const result = renderTemplate(preset.folderFormat, sampleTokens);
      expect(result).not.toMatch(/\{.*\}/);
    }
  });

  it('all preset fileFormats render without literal brace artifacts', () => {
    for (const preset of NAMING_PRESETS) {
      const result = renderFilename(preset.fileFormat, sampleTokens);
      expect(result).not.toMatch(/\{.*\}/);
    }
  });

  it('Audiobookshelf preset conditionally includes series in folder path', () => {
    const withSeries = renderTemplate('{author}/{series?/}{title}', sampleTokens);
    expect(withSeries).toBe('Brandon Sanderson/The Stormlight Archive/The Way of Kings');

    const withoutSeries = renderTemplate('{author}/{series?/}{title}', { ...sampleTokens, series: undefined });
    expect(withoutSeries).toBe('Brandon Sanderson/The Way of Kings');
  });
});

describe('Plex preset with prefix conditional syntax', () => {
  it('Plex preset fileFormat uses prefix syntax { - pt?trackNumber:00}', () => {
    const plex = NAMING_PRESETS.find(p => p.id === 'plex');
    expect(plex!.fileFormat).toBe('{title}{ - pt?trackNumber:00}');
  });

  it('Plex preset renders "Title - pt01" for multi-file', () => {
    const result = renderFilename('{title}{ - pt?trackNumber:00}', {
      title: 'The Way of Kings', trackNumber: 1, trackTotal: 12,
    });
    expect(result).toBe('The Way of Kings - pt01');
  });

  it('Plex preset renders "Title" for single-file (no trackNumber)', () => {
    const result = renderFilename('{title}{ - pt?trackNumber:00}', {
      title: 'The Way of Kings',
    });
    expect(result).toBe('The Way of Kings');
  });
});

describe('Detailed preset {edition} in fileFormat (#1829)', () => {
  const DETAILED_FILE = NAMING_PRESETS.find(p => p.id === 'detailed')!.fileFormat;
  const OLD_DETAILED_FILE = '{author} - {series? - }{seriesPosition:00? - }{title} {- ?trackNumber:000}';
  const base = {
    author: 'Brandon Sanderson', title: 'The Way of Kings',
    series: 'The Stormlight Archive', seriesPosition: 1,
  };

  it('renders the edition parenthetical before the track ordinal (multi-file)', () => {
    expect(renderFilename(DETAILED_FILE, { ...base, edition: 'Full Cast', trackNumber: 1, trackTotal: 12 }))
      .toBe('Brandon Sanderson - The Stormlight Archive - 01 - The Way of Kings (Full Cast) - 001');
  });

  it('renders the edition parenthetical with no trailing artifacts (single file, no track tokens)', () => {
    expect(renderFilename(DETAILED_FILE, { ...base, edition: 'Full Cast' }))
      .toBe('Brandon Sanderson - The Stormlight Archive - 01 - The Way of Kings (Full Cast)');
  });

  // No-edition parity: BOTH template deltas ({ (?edition?)} and folding the track
  // separator space into the conditional prefix) must be pure no-ops when no edition
  // exists — byte-identical to the pre-#1829 template. The {series? - } and
  // {seriesPosition:00? - } branches are where whitespace regressions hide.
  const parityCases: [string, Record<string, string | number | undefined>][] = [
    ['full metadata, multi-file', { ...base, trackNumber: 1, trackTotal: 12 }],
    ['full metadata, single-file', { ...base }],
    ['no series, multi-file', { author: base.author, title: base.title, trackNumber: 2, trackTotal: 3 }],
    ['no seriesPosition, single-file', { author: base.author, title: base.title, series: base.series }],
  ];
  for (const [label, tokens] of parityCases) {
    it(`renders byte-identical to the pre-edition template with no edition (${label})`, () => {
      expect(renderFilename(DETAILED_FILE, tokens)).toBe(renderFilename(OLD_DETAILED_FILE, tokens));
    });
  }

  it('treats an empty-string edition as absent (parity with the pre-edition template)', () => {
    const tokens = { ...base, edition: '', trackNumber: 1, trackTotal: 12 };
    expect(renderFilename(DETAILED_FILE, tokens)).toBe(renderFilename(OLD_DETAILED_FILE, tokens));
  });

  // F8: unlike the folder {edition} (verbatim), the file-side edition takes the
  // separator transform like any other token — pin it so the behavior is explicit.
  it('applies the separator transform to the file-side edition value (period separator)', () => {
    expect(renderFilename(DETAILED_FILE, { ...base, edition: 'Full Cast', trackNumber: 1, trackTotal: 12 }, { separator: 'period' }))
      .toBe('Brandon.Sanderson - The.Stormlight.Archive - 01 - The.Way.of.Kings (Full.Cast) - 001');
  });
});

describe('detectPreset', () => {
  it('returns preset id when both fields match a defined preset', () => {
    expect(detectPreset('{author}/{title}', '{author} - {title}')).toBe('standard');
    expect(detectPreset('{author}/{series}/{seriesPosition:00? - }{title}', '{author} - {series? - }{seriesPosition:00? - }{title}{ (?edition?)}{ - ?trackNumber:000}')).toBe('detailed');
    expect(detectPreset('{author}/{series?/}{title}', '{title}')).toBe('audiobookshelf');
    expect(detectPreset('{authorLastFirst}/{titleSort}', '{authorLastFirst} - {titleSort}')).toBe('last-first');
  });

  it('returns "custom" when only folderFormat matches', () => {
    expect(detectPreset('{author}/{title}', '{title}')).toBe('custom');
  });

  // #1829 — saved templates from before the edition token was added to the Detailed
  // fileFormat flip to Custom (cosmetic only; their rendering is unchanged, no migration).
  it('detects the pre-edition Detailed fileFormat as "custom"', () => {
    expect(detectPreset('{author}/{series}/{seriesPosition:00? - }{title}', '{author} - {series? - }{seriesPosition:00? - }{title} {- ?trackNumber:000}')).toBe('custom');
  });

  it('returns "custom" when only fileFormat matches', () => {
    expect(detectPreset('{author}', '{author} - {title}')).toBe('custom');
  });

  it('returns "custom" when neither field matches any preset', () => {
    expect(detectPreset('{title}/{author}', '{title} by {author}')).toBe('custom');
  });
});
