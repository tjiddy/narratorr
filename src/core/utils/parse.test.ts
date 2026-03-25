import { describe, it, expect } from 'vitest';
import { parseAudiobookTitle, slugify, formatBytes, isMultiPartUsenetPost } from './parse.js';

describe('parseAudiobookTitle', () => {
  describe('basic patterns', () => {
    it('parses a simple title with no structure', () => {
      const result = parseAudiobookTitle('The Way of Kings');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeUndefined();
    });

    it('returns empty title for empty string', () => {
      expect(parseAudiobookTitle('').title).toBe('');
    });

    it('returns hash as title for hash-only input', () => {
      const hash = 'a8f4c61ddcc5e8a2dabede0f3b482cd9';
      expect(parseAudiobookTitle(hash).title).toBe(hash);
      expect(parseAudiobookTitle(hash).author).toBeUndefined();
    });

    it('handles extra whitespace', () => {
      expect(parseAudiobookTitle('  The Way of Kings  ').title).toBe('The Way of Kings');
    });
  });

  describe('Author - Title pattern (dominant convention)', () => {
    it('extracts author and title from "Author - Title"', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings');
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
    });

    it('handles multiple-word author names', () => {
      const result = parseAudiobookTitle('Neil Gaiman, Dirk Maggs - The Sandman Akt III');
      expect(result.author).toBe('Neil Gaiman, Dirk Maggs');
      expect(result.title).toBe('The Sandman Akt III');
    });

    it('extracts from real NZBgeek result: Joe Abercrombie - Best Served Cold', () => {
      const result = parseAudiobookTitle('Joe Abercrombie - Best Served Cold');
      expect(result.author).toBe('Joe Abercrombie');
      expect(result.title).toBe('Best Served Cold');
    });
  });

  describe('Author-Title pattern (no space dash)', () => {
    it('extracts from "Stephen King-Desperation"', () => {
      const result = parseAudiobookTitle('Stephen King-Desperation');
      expect(result.author).toBe('Stephen King');
      expect(result.title).toBe('Desperation');
    });

    it('extracts from "Andy Weir-Project Hail Mary"', () => {
      const result = parseAudiobookTitle('Andy Weir-Project Hail Mary');
      expect(result.author).toBe('Andy Weir');
      expect(result.title).toBe('Project Hail Mary');
    });

    it('extracts author alias: Stephen King (AKA)- Richard Bachman - The Regulators', () => {
      const result = parseAudiobookTitle('Stephen King (AKA)- Richard Bachman - The Regulators');
      expect(result.author).toBe('Stephen King (AKA)- Richard Bachman');
      expect(result.title).toBe('The Regulators');
    });
  });

  describe('Author - Series ## - Title pattern', () => {
    it('extracts series from two-dash pattern', () => {
      const result = parseAudiobookTitle('Joe Abercrombie - First Law World 04 - Best Served Cold');
      expect(result.author).toBe('Joe Abercrombie');
      expect(result.title).toBe('Best Served Cold');
      expect(result.series).toBe('First Law World');
      expect(result.seriesPosition).toBe('04');
    });

    it('handles Bk/Book/Day keywords', () => {
      const result = parseAudiobookTitle('Patrick Rothfuss - Kingkiller Chronicles, Day 2 - The Wise Mans Fear');
      expect(result.author).toBe('Patrick Rothfuss');
      expect(result.title).toBe('The Wise Mans Fear');
      expect(result.series).toBe('Kingkiller Chronicles');
      expect(result.seriesPosition).toBe('2');
    });

    it('handles German series: Die Klingen-Saga', () => {
      const result = parseAudiobookTitle('Joe Abercrombie - Die Klingen-Saga 08 - Zauberklingen');
      expect(result.author).toBe('Joe Abercrombie');
      expect(result.title).toBe('Zauberklingen');
      expect(result.series).toBe('Die Klingen-Saga');
      expect(result.seriesPosition).toBe('08');
    });
  });

  describe('Title By Author pattern', () => {
    it('extracts from "Title By Author"', () => {
      const result = parseAudiobookTitle('Nation by Terry Pratchett');
      expect(result.title).toBe('Nation');
      expect(result.author).toBe('Terry Pratchett');
    });

    it('handles "By" with capital B', () => {
      const result = parseAudiobookTitle('Eight Men Out The Black Sox and the 1919 World Series by Eliot Asinof');
      expect(result.title).toContain('Eight Men Out');
      expect(result.author).toBe('Eliot Asinof');
    });
  });

  describe('Possessive Author pattern', () => {
    it('handles "Terry Pratchetts Discworld, Bk 22 - The Last Continent"', () => {
      const result = parseAudiobookTitle('Terry Pratchetts Discworld, Bk 22 - The Last Continent');
      expect(result.author).toBe('Terry Pratchett');
      expect(result.series).toBe('Discworld');
      expect(result.seriesPosition).toBe('22');
      expect(result.title).toBe('The Last Continent');
    });
  });

  describe('scene release format', () => {
    it('strips scene suffix and extracts author: CRAViNGS iNT', () => {
      const result = parseAudiobookTitle('Andy Weir - Project Hail Mary-AUDiOBOOK-WEB-DK-2023-CRAViNGS iNT');
      expect(result.author).toBe('Andy Weir');
      expect(result.title).toBe('Project Hail Mary');
      expect(result.year).toBe(2023);
    });

    it('strips scene suffix with tight dash: Stephen King-Institutet', () => {
      const result = parseAudiobookTitle('Stephen King-Institutet-AUDiOBOOK-WEB-SE-2019-CRAViNGS iNT');
      expect(result.author).toBe('Stephen King');
      expect(result.title).toBe('Institutet');
      expect(result.year).toBe(2019);
    });

    it('handles VOLDiES INT scene group', () => {
      const result = parseAudiobookTitle('Neil Gaiman und Dirk Maggs-The Sandman-AUDIOBOOK-WEB-DE-2021-VOLDiES INT');
      expect(result.author).toBe('Neil Gaiman und Dirk Maggs');
      expect(result.title).toBe('The Sandman');
      expect(result.year).toBe(2021);
    });
  });

  describe('NZB wrapper handling', () => {
    it('extracts from inner quoted filename', () => {
      const result = parseAudiobookTitle('(01/17) - Description - "Joe Abercrombie - Die Klingen-Saga 08 - Zauberklingen (Ungekuerzt).par2" - 1,35 GB');
      expect(result.author).toBe('Joe Abercrombie');
      expect(result.title).toBe('Zauberklingen');
      expect(result.series).toBe('Die Klingen-Saga');
      expect(result.isUnabridged).toBe(true);
    });

    it('strips Re: REQ: prefix', () => {
      const result = parseAudiobookTitle('Re: REQ: Brandon Sanderson - Tailored Realities - "Brandon_Sanderson_-_Tailored_Realities.vol127+73.par2"');
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('Tailored Realities');
    });

    it('strips NMR: prefix and handles title - author - year format', () => {
      // After stripping prefix and inner quote extraction, should find author
      const result = parseAudiobookTitle('NMR: Project Hail Mary - Andy Weir - 2021 [06/22] - "Andy Weir - 2021 - Project Hail Mary.part03.rar" yEnc');
      // Inner quote has "Andy Weir - 2021 - Project Hail Mary"
      expect(result.title).toContain('Project Hail Mary');
      expect(result.year).toBe(2021);
    });

    it('strips part numbers, yEnc, and size suffixes', () => {
      const result = parseAudiobookTitle('"Neil Gaiman & Terry Pratchett - Good Omens.nfo" (64kb) [002/142] yEnc');
      expect(result.author).toBe('Neil Gaiman & Terry Pratchett');
      expect(result.title).toBe('Good Omens');
    });
  });

  describe('narrator extraction', () => {
    it('extracts narrator from "narrated by" pattern', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings, narrated by Michael Kramer');
      expect(result.narrator).toBe('Michael Kramer');
      expect(result.author).toBe('Brandon Sanderson');
    });

    it('extracts narrator from "read by" pattern', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings, read by Kate Reading');
      expect(result.narrator).toBe('Kate Reading');
    });

    it('extracts "written and narrated by" as both narrator and author', () => {
      const result = parseAudiobookTitle('A Piano in the Pyrenees, written and narrated by Tony Hawks');
      expect(result.narrator).toBe('Tony Hawks');
      expect(result.author).toBe('Tony Hawks');
    });

    it('extracts narrator from "By Author-Narrated by Narrator" pattern', () => {
      const result = parseAudiobookTitle('Clear and Present Danger By Tom Clancy-Narrated by Michael Pritchard-2014 Audiobook-M4B');
      expect(result.author).toBe('Tom Clancy');
      expect(result.narrator).toBe('Michael Pritchard');
      expect(result.year).toBe(2014);
    });
  });

  describe('metadata extraction', () => {
    it('extracts year in brackets', () => {
      expect(parseAudiobookTitle('The Way of Kings [2010]').year).toBe(2010);
    });

    it('extracts year from scene suffix', () => {
      expect(parseAudiobookTitle('Author-Title-AUDiOBOOK-WEB-DK-2023-GROUP iNT').year).toBe(2023);
    });

    it('detects unabridged flag', () => {
      expect(parseAudiobookTitle('The Way of Kings [Unabridged]').isUnabridged).toBe(true);
    });

    it('detects Ungekuerzt as unabridged', () => {
      expect(parseAudiobookTitle('Author - Title (Ungekuerzt)').isUnabridged).toBe(true);
    });

    it('detects abridged flag', () => {
      expect(parseAudiobookTitle('The Way of Kings [Abridged]').isUnabridged).toBe(false);
    });

    it('extracts format MP3', () => {
      expect(parseAudiobookTitle('The Way of Kings MP3').format).toBe('MP3');
    });

    it('extracts format M4B', () => {
      expect(parseAudiobookTitle('The Way of Kings M4B').format).toBe('M4B');
    });

    it('extracts format case-insensitive', () => {
      expect(parseAudiobookTitle('The Way of Kings mp3').format).toBe('MP3');
    });

    it('strips bracketed metadata tags [MP3]', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings [MP3]');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBe('Brandon Sanderson');
    });

    it('strips bracketed metadata tags [ENG]', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings [ENG]');
      expect(result.title).toBe('The Way of Kings');
    });

    it('strips bracketed bitrate tags [128kbps]', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings [128kbps]');
      expect(result.title).toBe('The Way of Kings');
    });

    it('strips multiple bracketed tags', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings [MP3] [ENG] [Unabridged]');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBe('Brandon Sanderson');
    });
  });

  describe('edge cases', () => {
    it('handles "by" in title like "Stand by Me"', () => {
      // "Stand by Me" should not trigger "by" author extraction
      // because "Me" doesn't look like an author name
      const result = parseAudiobookTitle('Stand by Me');
      expect(result.title).toBe('Stand by Me');
    });

    it('handles unicode characters', () => {
      const result = parseAudiobookTitle('Margit Sandemo - Isfolket 9 Rödlöes');
      expect(result.author).toBe('Margit Sandemo');
    });

    it('handles title with multiple dashes (series within title)', () => {
      const result = parseAudiobookTitle('Neil Gaiman - Das Graveyard-Buch');
      expect(result.author).toBe('Neil Gaiman');
      expect(result.title).toBe('Das Graveyard-Buch');
    });

    it('strips [M4B] prefix tag', () => {
      const result = parseAudiobookTitle('[M4B] Andy Weir-Project Hail Mary');
      expect(result.author).toBe('Andy Weir');
      expect(result.title).toBe('Project Hail Mary');
    });

    it('handles combined metadata: year, format, unabridged', () => {
      const result = parseAudiobookTitle('Brandon Sanderson - The Way of Kings [2010] [Unabridged] MP3');
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
      expect(result.year).toBe(2010);
      expect(result.isUnabridged).toBe(true);
      expect(result.format).toBe('MP3');
    });
  });
});

describe('slugify', () => {
  it('converts to lowercase kebab-case', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('removes special characters', () => {
    expect(slugify("Hello, World! It's a test.")).toBe('hello-world-its-a-test');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('Hello   World')).toBe('hello-world');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify(' - Hello World - ')).toBe('hello-world');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });

  it('formats fractional values', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('rounds to 2 decimal places', () => {
    expect(formatBytes(1234567)).toBe('1.18 MB');
  });

  it('returns 0 B for negative input', () => {
    expect(formatBytes(-1)).toBe('0 B');
  });

  it('returns 0 B for large negative input', () => {
    expect(formatBytes(-1000)).toBe('0 B');
  });

  it('returns 0 B for NaN input', () => {
    expect(formatBytes(NaN)).toBe('0 B');
  });

  it('returns 0 B for Infinity input', () => {
    expect(formatBytes(Infinity)).toBe('0 B');
  });

  it('preserves 0 B output for zero after guard is added', () => {
    expect(formatBytes(0)).toBe('0 B');
  });
});

describe('isMultiPartUsenetPost', () => {
  it('detects quoted pattern "28" of "30"', () => {
    const result = isMultiPartUsenetPost('hp02.Harry Potter "28" of "30" yEnc');
    expect(result).toEqual({ match: true, part: 28, total: 30 });
  });

  it('detects "01" of "01" as match with total=1', () => {
    const result = isMultiPartUsenetPost('My Audiobook "01" of "01" yEnc');
    expect(result).toEqual({ match: true, part: 1, total: 1 });
  });

  it('detects "1" of "1" as match with total=1', () => {
    const result = isMultiPartUsenetPost('Some Book "1" of "1"');
    expect(result).toEqual({ match: true, part: 1, total: 1 });
  });

  it('detects unquoted pattern 08 of 30', () => {
    const result = isMultiPartUsenetPost('hp02.The Chamber of Secrets 08 of 30');
    expect(result).toEqual({ match: true, part: 8, total: 30 });
  });

  it('detects parenthesized slash pattern (8/30)', () => {
    const result = isMultiPartUsenetPost('Harry Potter Chapter 8 (8/30)');
    expect(result).toEqual({ match: true, part: 8, total: 30 });
  });

  it('returns no match for regular title', () => {
    const result = isMultiPartUsenetPost('Brandon Sanderson - The Way of Kings');
    expect(result).toEqual({ match: false });
  });

  it('matches pattern embedded in longer NZB title', () => {
    const title = 'hp02.Harry Potter and "hp02.The Chamber of Secrets - 16 - The Chamber of Secrets.mp3" by J.K.Rowling "28" of "30" yEnc';
    const result = isMultiPartUsenetPost(title);
    expect(result).toEqual({ match: true, part: 28, total: 30 });
  });

  it('handles spacing variants in quoted pattern', () => {
    const result = isMultiPartUsenetPost('Book "3"of"10"');
    expect(result).toEqual({ match: true, part: 3, total: 10 });
  });

  it('handles spacing in slash pattern', () => {
    const result = isMultiPartUsenetPost('Book (3 / 10)');
    expect(result).toEqual({ match: true, part: 3, total: 10 });
  });

  it('prefers quoted pattern over unquoted', () => {
    // Title with both quoted and unquoted — quoted wins (first pattern)
    const result = isMultiPartUsenetPost('Part 1 of 1 and "5" of "10"');
    expect(result).toEqual({ match: true, part: 5, total: 10 });
  });
});
