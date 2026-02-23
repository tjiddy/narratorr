import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAudiobookTitle } from './parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, '../__tests__/fixtures/release-corpus.json');

interface CorpusEntry {
  raw: string;
  source: string;
  indexer: string;
  capturedAt: string;
  expected: { author: string; title: string } | null;
}

const corpus: CorpusEntry[] = JSON.parse(readFileSync(corpusPath, 'utf-8'));
const annotated = corpus.filter((e) => e.expected !== null);
const unannotated = corpus.filter((e) => e.expected === null);

describe('parseAudiobookTitle — corpus regression', () => {
  if (annotated.length > 0) {
    describe('annotated entries', () => {
      for (const entry of annotated) {
        it(`parses: ${entry.raw.substring(0, 70)}`, () => {
          const result = parseAudiobookTitle(entry.raw);
          if (entry.expected!.author) {
            expect(result.author).toBe(entry.expected!.author);
          }
          if (entry.expected!.title) {
            expect(result.title).toBe(entry.expected!.title);
          }
        });
      }
    });
  }

  it(`runs parser on all ${unannotated.length} unannotated entries without throwing`, () => {
    for (const entry of unannotated) {
      expect(() => parseAudiobookTitle(entry.raw)).not.toThrow();
    }
  });

  it('extracts author from at least 80% of corpus entries', () => {
    let withAuthor = 0;
    for (const entry of corpus) {
      const result = parseAudiobookTitle(entry.raw);
      if (result.author) withAuthor++;
    }
    const rate = withAuthor / corpus.length;
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });
});
