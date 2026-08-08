import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg') };
});

import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService, BookDetail } from './book.service.js';
import type { SettingsService } from './settings.service.js';

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('@core/utils/ffprobe-path.js', () => ({
  resolveFfprobePathFromSettings: vi.fn().mockReturnValue('/usr/bin/ffprobe'),
}));

vi.mock('../utils/import-helpers.js', () => ({
  getVisiblePathSize: vi.fn().mockResolvedValue(1_000_000),
}));

// The default root is a DIRECTORY, and it must answer `isFile()` as well as `isDirectory()`:
// `refreshScanBook` classifies the root from this one stat to decide whether to `readdir` at all.
// A factory missing `isFile` is not a type error (nothing typechecks a `vi.mock` factory) — it
// throws `rootStat.isFile is not a function` at runtime in every test in this suite.
vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false }),
  readdir: vi.fn().mockResolvedValue([]),
}));

// The READER is mocked, not the filesystem underneath it. Letting the real `readOpfMetadata` load
// would make every OPF assertion vacuous: the `node:fs/promises` factory above is a full module
// replace, so `readFile` is `undefined`, and `readOpfSource`'s catch-all swallows the resulting
// TypeError into the same `null` an absent sidecar produces — every "OPF wins" case would go green
// while proving nothing. (The blanket `stat` compounds it: no `size` makes the MAX_OPF_BYTES check
// read `undefined > 4MB`, i.e. the sidecar looks present and in-bounds.) The reader's own parse and
// failure contracts are pinned against the real filesystem in `../utils/opf-reader.fs.test.ts`.
vi.mock('../utils/opf-reader.js', () => ({
  readOpfMetadata: vi.fn(),
}));

import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { getVisiblePathSize } from '../utils/import-helpers.js';
import { readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { readOpfMetadata } from '../utils/opf-reader.js';
import type { OpfMetadata } from '../utils/opf-reader.js';
import { refreshScanBook, RefreshScanError } from './refresh-scan.service.js';

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  });
}

function makeScanResult(overrides: Record<string, unknown> = {}) {
  return {
    codec: 'mp3',
    bitrate: 128000,
    sampleRate: 44100,
    channels: 2,
    bitrateMode: 'cbr' as const,
    fileFormat: 'MPEG',
    fileCount: 3,
    totalSize: 300_000_000,
    totalDuration: 7200,
    hasCoverArt: false,
    ...overrides,
  };
}

function makeOpf(overrides: Partial<OpfMetadata> = {}): OpfMetadata {
  return {
    title: null,
    subtitle: null,
    authors: [],
    narrators: [],
    description: null,
    publisher: null,
    publishedDate: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    genres: [],
    ...overrides,
  };
}

function makeBook(overrides: Partial<BookDetail> = {}): BookDetail {
  return inject<BookDetail>({
    userClearedFields: [],
    id: 1,
    title: 'Test Book',
    path: '/library/author/book',
    status: 'imported',
    duration: 60,
    narrators: [{ name: 'Old Narrator' }],
    authors: [{ name: 'Test Author' }],
    coverUrl: '/api/books/1/cover',
    ...overrides,
  });
}

describe('RefreshScanError', () => {
  it('has name RefreshScanError and exposes code property', () => {
    const error = new RefreshScanError('NOT_FOUND', 'Book 1 not found');
    expect(error.name).toBe('RefreshScanError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Book 1 not found');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('refreshScanBook', () => {
  let mockBookService: BookService;
  let mockSettingsService: SettingsService;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockBookService = inject<BookService>({
      getById: vi.fn().mockResolvedValue(makeBook()),
      update: vi.fn().mockResolvedValue(makeBook()),
      syncNarrators: vi.fn().mockResolvedValue(undefined),
    });

    mockSettingsService = inject<SettingsService>({
      get: vi.fn().mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' }),
    });

    log = createMockLogger();

    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult());
    vi.mocked(readdir).mockResolvedValue(
      ['ch1.mp3', 'ch2.mp3', 'ch3.mp3'] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    // Default: no sidecar. Cases that assert OPF precedence opt in explicitly.
    vi.mocked(readOpfMetadata).mockResolvedValue(null);
  });

  // Happy path
  it('returns RefreshScanResult with bookId, codec, bitrate, fileCount, durationMinutes, narratorsUpdated', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'New Narrator' }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(result).toEqual({
      bookId: 1,
      codec: 'mp3',
      bitrate: 128000,
      fileCount: 3,
      durationMinutes: 120,
      narratorsUpdated: true,
    });
  });

  it('durationMinutes is Math.round(totalDuration / 60) — 90s → 2 min', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 90 }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(result.durationMinutes).toBe(2);
  });

  it('durationMinutes rounding — 89s → 1 min', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 89 }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(result.durationMinutes).toBe(1);
  });

  it('zero-duration audio file → durationMinutes is 0', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 0 }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(result.durationMinutes).toBe(0);
  });

  // Audio fields overwrite — via bookService.update()
  it('overwrites all 10 audio technical fields from scan results', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);

    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        audioCodec: 'mp3',
        audioBitrate: 128000,
        audioSampleRate: 44100,
        audioChannels: 2,
        audioBitrateMode: 'cbr',
        audioFileFormat: 'MPEG',
        audioFileCount: 3,
        audioTotalSize: 300_000_000,
        audioDuration: 7200,
        topLevelAudioFileCount: 3,
      }),
    );
  });

  it('updates size field with total recursive directory size via getVisiblePathSize', async () => {
    vi.mocked(getVisiblePathSize).mockResolvedValue(5_000_000);
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(getVisiblePathSize).toHaveBeenCalledWith('/library/author/book');
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ size: 5_000_000 }),
    );
  });

  it('sets enrichmentStatus to file-enriched', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ enrichmentStatus: 'file-enriched' }),
    );
  });

  it('sets duration in minutes', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ duration: 120 }),
    );
  });

  // Zero-duration skip-write guard: an all-rejected scan (every file's duration omitted as
  // implausible) yields totalDuration 0 and must NOT clobber the stored duration/audioDuration.
  it('does not write duration/audioDuration when totalDuration is 0 (skip-write guard)', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 0 }));
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    const updateArg = vi.mocked(mockBookService.update).mock.calls[0]![1];
    expect(updateArg).not.toHaveProperty('duration');
    expect(updateArg).not.toHaveProperty('audioDuration');
    // Other technical fields still refresh.
    expect(updateArg).toEqual(expect.objectContaining({ audioCodec: 'mp3', audioTotalSize: 300_000_000 }));
    expect(log.warn).toHaveBeenCalled();
  });

  it('writes duration/audioDuration when totalDuration is > 0 (guard not triggered)', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    const updateArg = vi.mocked(mockBookService.update).mock.calls[0]![1];
    expect(updateArg).toEqual(expect.objectContaining({ duration: 120, audioDuration: 7200 }));
  });

  // Narrator ladder (#2161): OPF sidecar → embedded tags → preserve what's stored.
  // This case is the rewrite of the old 'overwrites narrator from tags even when book already has
  // narrators', which pinned the defect: a curated narrator exported to the sidecar was reverted to
  // whatever the audio tags said on every "Refresh from files".
  it('OPF narrators win over a stale tag narrator', async () => {
    vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ narrators: ['Curated Narrator'] }));
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Stale Tag' }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ narrators: ['Curated Narrator'] }),
    );
    expect(result.narratorsUpdated).toBe(true);
  });

  // One case covers absent / unreadable / oversized / malformed / no-usable-field: `readOpfMetadata`
  // collapses all five to `null` by contract, and each is pinned individually against the real
  // filesystem in `../utils/opf-reader.fs.test.ts`.
  it('falls through to the tag narrator when the reader yields no sidecar', async () => {
    vi.mocked(readOpfMetadata).mockResolvedValue(null);
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Tag Narrator' }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ narrators: ['Tag Narrator'] }),
    );
    expect(result.narratorsUpdated).toBe(true);
  });

  it('falls through to the tag narrator when the sidecar carries no narrators', async () => {
    vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ narrators: [], title: 'Test Book' }));
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Tag Narrator' }));
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ narrators: ['Tag Narrator'] }),
    );
  });

  it('writes OPF narrators when there is no tag narrator at all', async () => {
    vi.mocked(readOpfMetadata).mockResolvedValue(makeOpf({ narrators: ['A', 'B'] }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ narrators: ['A', 'B'] }),
    );
    expect(result.narratorsUpdated).toBe(true);
  });

  it('preserves stored narrators when neither source supplies names', async () => {
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    const updateArg = vi.mocked(mockBookService.update).mock.calls[0]![1];
    // Not `narrators: []` — `book.service.ts` ignores an empty array, which would leave the payload
    // and `narratorsUpdated` disagreeing about what was written.
    expect(updateArg).not.toHaveProperty('narrators');
    expect(result.narratorsUpdated).toBe(false);
  });

  // `narratorsUpdated` means "a source actually supplied a replacement", not "a tag field existed".
  // Both of these derive to `[]` and therefore write nothing.
  it('narratorsUpdated is false for a whitespace-only tag narrator', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: '   ' }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(vi.mocked(mockBookService.update).mock.calls[0]![1]).not.toHaveProperty('narrators');
    expect(result.narratorsUpdated).toBe(false);
  });

  it('narratorsUpdated is false for a delimiters-only tag narrator', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: ',;&' }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(vi.mocked(mockBookService.update).mock.calls[0]![1]).not.toHaveProperty('narrators');
    expect(result.narratorsUpdated).toBe(false);
  });

  // OPF narrators are already trimmed, de-duplicated and non-empty by `normalizeArray`, and the
  // import overlay uses them verbatim. Re-splitting would shred a duo credited under one name.
  it('uses OPF narrators verbatim — a duo credited under one name is not split', async () => {
    vi.mocked(readOpfMetadata).mockResolvedValue(
      makeOpf({ narrators: ['Rosalyn Landor & Simon Vance'] }),
    );
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ narrators: ['Rosalyn Landor & Simon Vance'] }),
    );
  });

  // With the reader mocked, this is the only thing proving the service consults the sidecar at all.
  it('reads the sidecar exactly once, from the book path', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(readOpfMetadata).toHaveBeenCalledTimes(1);
    expect(readOpfMetadata).toHaveBeenCalledWith('/library/author/book', log);
  });

  it('splits multi-narrator tag on comma, semicolon, ampersand delimiters', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(
      makeScanResult({ tagNarrator: 'Narrator A; Narrator B & Narrator C, Narrator D' }),
    );
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        narrators: ['Narrator A', 'Narrator B', 'Narrator C', 'Narrator D'],
      }),
    );
  });

  it('narratorsUpdated is true when tagNarrator was present', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Narrator' }));
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(result.narratorsUpdated).toBe(true);
  });

  it('does not update narrator when tagNarrator is absent from scan result', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult()); // no tagNarrator
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    const updateArg = vi.mocked(mockBookService.update).mock.calls[0]![1];
    expect(updateArg).not.toHaveProperty('narrators');
  });

  it('narratorsUpdated is false when tagNarrator is absent', async () => {
    const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(result.narratorsUpdated).toBe(false);
  });

  // Cover art excluded
  it('passes skipCover: true to scanAudioDirectory', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(scanAudioDirectory).toHaveBeenCalledWith(
      '/library/author/book',
      expect.objectContaining({ skipCover: true }),
    );
  });

  // Preserved fields
  it('does not include title, author, series, description, coverUrl, genres in DB update', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    const updateArg = vi.mocked(mockBookService.update).mock.calls[0]![1];
    expect(updateArg).not.toHaveProperty('title');
    expect(updateArg).not.toHaveProperty('description');
    expect(updateArg).not.toHaveProperty('coverUrl');
    expect(updateArg).not.toHaveProperty('seriesName');
    expect(updateArg).not.toHaveProperty('seriesPosition');
    expect(updateArg).not.toHaveProperty('genres');
  });

  // Atomicity — bookService.update() wraps narrators + book row in a single transaction
  it('calls bookService.update() with narrators and audio fields together for atomicity', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Narrator' }));
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    // Single update call contains both audio fields AND narrators
    expect(mockBookService.update).toHaveBeenCalledTimes(1);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        narrators: ['Narrator'],
        audioCodec: 'mp3',
      }),
    );
  });

  it('propagates bookService.update() failure', async () => {
    vi.mocked(mockBookService.update).mockRejectedValue(new Error('DB constraint failure'));
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log)).rejects.toThrow('DB constraint failure');
  });

  it('propagates readdir failure instead of silently zeroing topLevelAudioFileCount', async () => {
    vi.mocked(readdir).mockRejectedValue(new Error('EACCES: permission denied'));
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log)).rejects.toThrow('EACCES: permission denied');
    // bookService.update should NOT have been called — the error should prevent persisting bad data
    expect(mockBookService.update).not.toHaveBeenCalled();
  });

  // topLevelAudioFileCount
  it('counts only root-level audio files for topLevelAudioFileCount', async () => {
    vi.mocked(readdir).mockResolvedValue(
      ['ch1.mp3', 'ch2.m4b', 'cover.jpg', 'subfolder'] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ topLevelAudioFileCount: 2 }),
    );
  });

  it('#1852: excludes a born-hidden temp from topLevelAudioFileCount', async () => {
    vi.mocked(readdir).mockResolvedValue(
      ['002.mp3', '.002.tmp.mp3', 'cover.jpg'] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(mockBookService.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ topLevelAudioFileCount: 1 }),
    );
  });

  // The one-root-stat invariant holds for BOTH arms — the directory arm can regress the same way,
  // by re-statting to classify instead of consuming the probe's result. See the file-root twin.
  it('probes the root exactly once for a directory root too', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith('/library/author/book');
  });

  // #2172 — single-file pointer books. A pointer import persists a FILE path
  // (`/audiobooks/Doctor Sleep.m4b`), which the count's `readdir` used to reject ENOTDIR, failing the
  // whole refresh before `bookService.update` was reached.
  //
  // Every case below decides the root kind from a MOCKED stat, so none of them can observe the real
  // ENOTDIR — `refresh-scan.service.fs.test.ts` carries the real-filesystem counterfactual.
  describe('file root (#2172)', () => {
    /**
     * Arm the book path and the single root `stat` probe for this test's one `refreshScanBook` call.
     *
     * `*Once` on `stat`, not `mockResolvedValue`: the suite's `beforeEach` runs `vi.clearAllMocks()`,
     * which clears call history but does NOT restore implementations — a plain `mockResolvedValue`
     * here would leak the file root into every later test. The flip side is that an armed `*Once`
     * value is not drained either, so each of these tests must consume exactly one.
     */
    function armPointerBook(path: string): void {
      vi.mocked(mockBookService.getById).mockResolvedValue(makeBook({ path }));
      vi.mocked(stat).mockResolvedValueOnce(inject<Stats>({ isFile: () => true, isDirectory: () => false }));
    }

    it('a visible .m4b pointer counts 1 and issues no readdir at all', async () => {
      armPointerBook('/audiobooks/Doctor Sleep.m4b');
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(mockBookService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ topLevelAudioFileCount: 1 }),
      );
      // The fix is a branch, not a rescue: the count alone would also be satisfied by a readdir
      // whose ENOTDIR was swallowed, which is exactly the shape that would destroy the directory
      // propagation contract pinned above.
      expect(readdir).not.toHaveBeenCalled();
    });

    // F1/AC1 — the root is probed exactly ONCE, and that one stat answers both questions: "does the
    // path exist?" (the PATH_MISSING probe) and "is the root a file?" (this branch). Nothing else in
    // the count path may re-stat: a second probe reintroduces a TOCTOU window between the two
    // answers and a second failure surface that the `isDefinitiveAbsence` mapping does not cover.
    // Without this assertion an inline `(await stat(book.path)).isFile()` added before the branch
    // would leave the whole suite green.
    it('probes the root exactly once, with the book path', async () => {
      armPointerBook('/audiobooks/Doctor Sleep.m4b');
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(stat).toHaveBeenCalledTimes(1);
      expect(stat).toHaveBeenCalledWith('/audiobooks/Doctor Sleep.m4b');
    });

    it('lowercases the extension — a .M4B pointer counts 1', async () => {
      armPointerBook('/audiobooks/Doctor Sleep.M4B');
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(mockBookService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ topLevelAudioFileCount: 1 }),
      );
    });

    it('consults AUDIO_EXTENSIONS, not the .m4b literal — a .mp3 pointer counts 1', async () => {
      armPointerBook('/audiobooks/Doctor Sleep.mp3');
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(mockBookService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ topLevelAudioFileCount: 1 }),
      );
    });

    // The three cases below pin the `else 0` arm UNDER A MOCKED SCANNER only. In production they are
    // unreachable through this function: the real `scanAudioDirectory` applies the same
    // visible-and-audio predicate to a direct-file root and returns null first, so refresh throws
    // NO_AUDIO_FILES before the count is computed. The operator-facing outcome for these same inputs
    // is asserted in the pair that follows.
    it.each([
      ['hidden basename', '/audiobooks/.Doctor Sleep.m4b'],
      ['non-audio extension', '/audiobooks/Doctor Sleep.txt'],
      ['no extension at all', '/audiobooks/Doctor Sleep'],
    ])('branch-pinning under a mocked scanner: %s counts 0', async (_label, path) => {
      armPointerBook(path);
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(mockBookService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ topLevelAudioFileCount: 0 }),
      );
      expect(readdir).not.toHaveBeenCalled();
    });

    it.each([
      ['hidden basename', '/audiobooks/.Doctor Sleep.m4b'],
      ['non-audio extension', '/audiobooks/Doctor Sleep.txt'],
      ['no extension at all', '/audiobooks/Doctor Sleep'],
    ])('operator outcome for %s: NO_AUDIO_FILES, nothing written', async (_label, path) => {
      armPointerBook(path);
      // What the real scanner returns for a file root failing the same predicate.
      vi.mocked(scanAudioDirectory).mockResolvedValueOnce(null);
      await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
        .rejects.toMatchObject({ code: 'NO_AUDIO_FILES' });
      expect(mockBookService.update).not.toHaveBeenCalled();
    });

    // The new branch must not skip the other readers on the same path — both are already file-safe.
    it('still sizes the pointer through getVisiblePathSize and writes the result', async () => {
      armPointerBook('/audiobooks/Doctor Sleep.m4b');
      vi.mocked(getVisiblePathSize).mockResolvedValueOnce(42_000_000);
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(getVisiblePathSize).toHaveBeenCalledTimes(1);
      expect(getVisiblePathSize).toHaveBeenCalledWith('/audiobooks/Doctor Sleep.m4b');
      expect(mockBookService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ size: 42_000_000, topLevelAudioFileCount: 1 }),
      );
    });

    // A pointer never gains sidecar narrators — the reader's own extension guard yields null — so the
    // ladder falls to the tag exactly as it does for a directory root. Existing behaviour, pinned
    // here because the new branch runs immediately before it.
    it('still consults the sidecar reader, and its null leaves narrators to the tag ladder', async () => {
      armPointerBook('/audiobooks/Doctor Sleep.m4b');
      vi.mocked(readOpfMetadata).mockResolvedValue(null);
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Tag Narrator' }));
      const result = await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(readOpfMetadata).toHaveBeenCalledTimes(1);
      expect(readOpfMetadata).toHaveBeenCalledWith('/audiobooks/Doctor Sleep.m4b', log);
      expect(mockBookService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ narrators: ['Tag Narrator'] }),
      );
      expect(result.narratorsUpdated).toBe(true);
    });

    // The one genuine feature interaction the branch introduces: the count is written even when the
    // zero-duration skip-write guard strips the duration fields.
    it('writes the count even when the zero-duration skip-write guard fires', async () => {
      armPointerBook('/audiobooks/Doctor Sleep.m4b');
      vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 0 }));
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      const updateArg = vi.mocked(mockBookService.update).mock.calls[0]![1];
      expect(updateArg).not.toHaveProperty('duration');
      expect(updateArg).not.toHaveProperty('audioDuration');
      expect(updateArg).toEqual(expect.objectContaining({ topLevelAudioFileCount: 1 }));
      expect(log.warn).toHaveBeenCalled();
    });

    // The root kind is decided by `stat`, never by the extension. A DIRECTORY named
    // `Doctor Sleep.m4b` is a real post-botched-import shape, and an extension-only pointer check
    // gets it wrong — it would report 1 instead of reading the two chapters inside.
    it('a DIRECTORY whose name carries an audio extension is still read with readdir', async () => {
      vi.mocked(mockBookService.getById).mockResolvedValue(makeBook({ path: '/library/Doctor Sleep.m4b' }));
      vi.mocked(stat).mockResolvedValueOnce(inject<Stats>({ isFile: () => false, isDirectory: () => true }));
      vi.mocked(readdir).mockResolvedValue(
        ['ch1.mp3', 'ch2.mp3'] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      await refreshScanBook(1, mockBookService, mockSettingsService, log);
      expect(readdir).toHaveBeenCalledWith('/library/Doctor Sleep.m4b');
      expect(mockBookService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ topLevelAudioFileCount: 2 }),
      );
    });

    // Only `isFile()` takes the new branch. A root that is neither (FIFO, socket, device node) keeps
    // today's behaviour exactly: it falls through to the readdir and that call's error propagates.
    it('a root that is neither file nor directory still falls through to readdir, and its failure propagates', async () => {
      vi.mocked(stat).mockResolvedValueOnce(inject<Stats>({ isFile: () => false, isDirectory: () => false }));
      vi.mocked(readdir).mockRejectedValue(new Error('ENOTDIR: not a directory'));
      await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
        .rejects.toThrow('ENOTDIR: not a directory');
      expect(readdir).toHaveBeenCalledWith('/library/author/book');
      expect(mockBookService.update).not.toHaveBeenCalled();
    });
  });

  // Error paths
  it('throws RefreshScanError NOT_FOUND when book does not exist', async () => {
    vi.mocked(mockBookService.getById).mockResolvedValue(null);
    await expect(refreshScanBook(999, mockBookService, mockSettingsService, log))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws RefreshScanError NO_PATH when book has no library path', async () => {
    vi.mocked(mockBookService.getById).mockResolvedValue(makeBook({ path: null }));
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
      .rejects.toMatchObject({ code: 'NO_PATH' });
  });

  it('throws RefreshScanError PATH_MISSING when book path does not exist on disk (ENOENT)', async () => {
    const { stat: statFn } = await import('node:fs/promises');
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    vi.mocked(statFn).mockRejectedValueOnce(enoent);
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
      .rejects.toMatchObject({ code: 'PATH_MISSING' });
  });

  it('throws RefreshScanError PATH_MISSING when the path statted ENOTDIR (#1965)', async () => {
    // ENOTDIR is the other definitive absence: the book's library path (or a parent)
    // became a regular file. Before #1965 the inline check tested `code === 'ENOENT'`
    // only, so this escaped as a raw errno instead of PATH_MISSING.
    const { stat: statFn } = await import('node:fs/promises');
    const enotdir = Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
    vi.mocked(statFn).mockRejectedValueOnce(enotdir);
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
      .rejects.toMatchObject({ code: 'PATH_MISSING' });
  });

  it('classifies a plain non-Error throw carrying a definitive errno (#1965)', async () => {
    // The old inline check also required `error instanceof Error`, so a bare
    // `{ code: 'ENOENT' }` — which some fs wrappers throw — fell through to the
    // rethrow. `isDefinitiveAbsence` reads the code off any object.
    const { stat: statFn } = await import('node:fs/promises');
    vi.mocked(statFn).mockRejectedValueOnce({ code: 'ENOENT' });
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
      .rejects.toMatchObject({ code: 'PATH_MISSING' });
  });

  it('rethrows non-ENOENT stat errors as unexpected failures', async () => {
    const { stat: statFn } = await import('node:fs/promises');
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    // toMatchObject alone won't prove it's NOT a RefreshScanError — need both assertions on fresh calls (#468)
    vi.mocked(statFn).mockRejectedValueOnce(eacces);
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
      .rejects.toMatchObject({ message: 'EACCES: permission denied' });
    vi.mocked(statFn).mockRejectedValueOnce(eacces);
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
      .rejects.not.toBeInstanceOf(RefreshScanError);
  });

  it('throws RefreshScanError NO_AUDIO_FILES when scanAudioDirectory returns null', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(null);
    await expect(refreshScanBook(1, mockBookService, mockSettingsService, log))
      .rejects.toMatchObject({ code: 'NO_AUDIO_FILES' });
  });

  // ffprobePath
  it('resolves ffprobePath from processing settings before calling scan', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    expect(resolveFfprobePathFromSettings).toHaveBeenCalledWith('/usr/bin/ffmpeg');
    expect(scanAudioDirectory).toHaveBeenCalledWith(
      '/library/author/book',
      expect.objectContaining({ ffprobePath: '/usr/bin/ffprobe' }),
    );
  });

  // Diagnostic callback wiring — onWarn → log.warn(payload, msg); onDebug → log.debug(payload, msg)
  it('forwards onWarn/onDebug callbacks to the injected logger', async () => {
    await refreshScanBook(1, mockBookService, mockSettingsService, log);
    const options = vi.mocked(scanAudioDirectory).mock.calls[0]![1]!;
    expect(options.onWarn).toEqual(expect.any(Function));
    expect(options.onDebug).toEqual(expect.any(Function));

    options.onWarn!('warn-msg', { warnPayload: 1 });
    expect(log.warn).toHaveBeenCalledWith({ warnPayload: 1 }, 'warn-msg');
    options.onDebug!('debug-msg', { debugPayload: 2 });
    expect(log.debug).toHaveBeenCalledWith({ debugPayload: 2 }, 'debug-msg');
  });
});
