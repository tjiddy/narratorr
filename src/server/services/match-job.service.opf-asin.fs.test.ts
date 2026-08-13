// #2292 — the single real-filesystem proof that matching reads the sidecar off disk. Every other
// rung test mocks `opf-reader`, so without this one nothing pins the wiring between
// `matchSingleBook` and an actual `metadata.opf`. The reader is deliberately NOT mocked here.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg') };
});

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

import { createMockLogger, inject } from '../__tests__/helpers.js';
import { MatchJobService, type MatchCandidate, type MatchResult } from './match-job.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';

const GUNSLINGER_ASIN = 'B019NNU7XE';

const OPF_XML = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Gunslinger</dc:title>
    <dc:creator opf:role="aut">Stephen King</dc:creator>
    <dc:identifier opf:scheme="ASIN">${GUNSLINGER_ASIN}</dc:identifier>
  </metadata>
</package>`;

describe('MatchJobService — the OPF ASIN rung reads a real sidecar (#2292)', () => {
  let root: string;
  let bookFolder: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'opf-asin-rung-'));
    bookFolder = path.join(root, 'Stephen King', 'The Gunslinger');
    await mkdir(bookFolder, { recursive: true });
    await writeFile(path.join(bookFolder, 'metadata.opf'), OPF_XML, 'utf-8');
  });

  afterAll(async () => {
    // Tolerant teardown: a leaked tmpdir is cheaper than a Windows EPERM failing the suite.
    try {
      await rm(root, { recursive: true, force: true });
    } catch { /* see windows-hostile-test-primitives */ }
  });

  async function runMatch(): Promise<{ result: MatchResult; getBook: ReturnType<typeof vi.fn> }> {
    const getBook = vi.fn().mockResolvedValue({
      title: 'Dark Tower I',
      authors: [{ name: 'Stephen King' }],
      asin: GUNSLINGER_ASIN,
    });
    const searchBooks = vi.fn().mockResolvedValue([]);
    const service = new MatchJobService(
      inject<MetadataService>({ getBook, searchBooks, getChapterRuntimeSeconds: vi.fn().mockResolvedValue({}) }),
      inject<FastifyBaseLogger>(createMockLogger()),
      inject<SettingsService>({ get: vi.fn().mockResolvedValue({ ffmpegPath: '' }) }),
      inject<BookService>({ findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }) }),
    );

    // The curated folder name is exactly what today's text search fails on.
    const candidate: MatchCandidate = { path: bookFolder, title: 'The Gunslinger', author: 'Stephen King' };
    const id = service.createJob([candidate]);
    for (let i = 0; i < 200 && service.getJob(id)?.status === 'matching'; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(searchBooks).not.toHaveBeenCalled();
    return { result: service.getJob(id)!.results[0]!, getBook };
  }

  it('resolves a curated title from the ASIN in its on-disk metadata.opf', async () => {
    const { result, getBook } = await runMatch();

    expect(getBook.mock.calls).toEqual([[GUNSLINGER_ASIN]]);
    expect(result.confidence).toBe('high');
    expect(result.bestMatch?.title).toBe('Dark Tower I');
  });
});
