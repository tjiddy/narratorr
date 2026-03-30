import { describe, it, expect } from 'vitest';
import { NAMING_PRESETS, detectPreset } from './naming-presets.js';
import { renderTemplate, renderFilename } from './naming.js';

describe('NAMING_PRESETS', () => {
  it('has exactly 4 presets', () => {
    expect(NAMING_PRESETS).toHaveLength(4);
  });

  it('contains Standard preset with correct formats', () => {
    const preset = NAMING_PRESETS.find(p => p.id === 'standard');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Standard');
    expect(preset!.folderFormat).toBe('{author}/{title}');
    expect(preset!.fileFormat).toBe('{author} - {title}');
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
    expect(preset!.fileFormat).toBe('{title}{trackNumber:00? - pt}');
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
  it.todo('Plex preset fileFormat is {title}{ - pt?trackNumber:00}');
  it.todo('Plex preset renders Title - pt01.m4b for multi-file');
  it.todo('Plex preset renders Title.m4b for single-file (no trackNumber)');
});

describe('detectPreset', () => {
  it('returns preset id when both fields match a defined preset', () => {
    expect(detectPreset('{author}/{title}', '{author} - {title}')).toBe('standard');
    expect(detectPreset('{author}/{series?/}{title}', '{title}')).toBe('audiobookshelf');
    expect(detectPreset('{authorLastFirst}/{titleSort}', '{authorLastFirst} - {titleSort}')).toBe('last-first');
  });

  it('returns "custom" when only folderFormat matches', () => {
    expect(detectPreset('{author}/{title}', '{title}')).toBe('custom');
  });

  it('returns "custom" when only fileFormat matches', () => {
    expect(detectPreset('{author}', '{author} - {title}')).toBe('custom');
  });

  it('returns "custom" when neither field matches any preset', () => {
    expect(detectPreset('{title}/{author}', '{title} by {author}')).toBe('custom');
  });
});
