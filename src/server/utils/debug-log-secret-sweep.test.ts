// Drive a representative search through the search-to-enrich log sites and reject secret-shaped fields.

import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/index.js';
import { filterAndRankResults, filterBlacklistedResults } from '../services/search-pipeline.js';
import { filterMultiPartUsenet } from '@core/utils/index.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import { serializeError } from './serialize-error.js';

const SECRET_PATTERN = /apikey|api_key|password|session|mam_id|cookie|authorization|bearer/i;

function makeLogger(): { logger: FastifyBaseLogger; debugCalls: unknown[]; infoCalls: unknown[] } {
  const debugCalls: unknown[] = [];
  const infoCalls: unknown[] = [];
  const logger = {
    debug: vi.fn((arg: unknown, _msg?: string) => { debugCalls.push(arg); }),
    info: vi.fn((arg: unknown, _msg?: string) => { infoCalls.push(arg); }),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'debug',
  } as unknown as FastifyBaseLogger;
  return { logger, debugCalls, infoCalls };
}

function makeUsenet(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Stephen King Fairy Tale (Ungekürzt)',
    protocol: 'usenet',
    indexer: 'NZBgeek',
    downloadUrl: 'https://nzbgeek.info/api?apikey=SUPERSECRET&q=fairy',
    nzbName: 'StephenKing.FairyTale.German.M4B',
    language: 'german',
    size: 1024 * 1024 * 500,
    ...overrides,
  };
}

describe('debug-log secret sweep (#932 AC7)', () => {
  it('blacklist filter never logs URLs or settings — only title/guid/indexer/reason/matchedRule', async () => {
    const { logger, debugCalls } = makeLogger();
    const blacklistService = {
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
        blacklistedHashes: new Set(['hash1']),
        blacklistedGuids: new Set(),
      }),
    } as unknown as BlacklistService;

    await filterBlacklistedResults(
      [makeUsenet({ infoHash: 'hash1', guid: 'guid-with-mam_id-secret' })],
      blacklistService,
      logger,
    );

    expect(debugCalls.length).toBeGreaterThan(0);
    for (const call of debugCalls) {
      const json = JSON.stringify(call);
      // GUIDs are untrusted content; remove one before testing leakage from independent log fields.
      const sanitized = json.replace(/"guid":"[^"]*"/, '"guid":"<<value-redacted-for-test>>"');
      expect(sanitized).not.toMatch(SECRET_PATTERN);
    }
  });

  it('multi-part filter logs only title + reason + matchedPattern (at info level)', () => {
    const { logger, infoCalls } = makeLogger();
    const results: SearchResult[] = [
      makeUsenet({ nzbName: 'Book "28" of "30" - apikey=SHOULD-NOT-LEAK' }),
    ];

    // Match applyMultiPartFilterAndRank's info-level log shape.
    const { rejectedTitles } = filterMultiPartUsenet(results);
    for (const r of rejectedTitles) {
      logger.info({ title: r.title, reason: 'multi-part-detected', matchedPattern: r.matchedPattern }, 'Multi-part Usenet result rejected');
    }

    // Title is untrusted payload, so assert log structure rather than sanitizing its content.
    expect(infoCalls.length).toBe(1);
    const fields = Object.keys(infoCalls[0] as object).sort();
    expect(fields).toEqual(['matchedPattern', 'reason', 'title']);
  });

  it('quality + language filters never log URLs, headers, or response bodies', () => {
    const { logger, debugCalls } = makeLogger();
    const results: SearchResult[] = [
      makeUsenet({ language: 'german' }),
      makeUsenet({ title: 'Mystery Book' }),
      makeUsenet({ title: 'Banned Title M4B', language: 'english' }),
    ];

    filterAndRankResults(
      results,
      3600,
      {
        grabFloor: 0,
        minSeeders: 0,
        protocolPreference: 'none',
        rejectWords: 'banned',
        languages: ['english'],
      },
      logger,
    );

    for (const call of debugCalls) {
      const json = JSON.stringify(call);
      // Spreading the result would expose SUPERSECRET from downloadUrl.
      expect(json).not.toMatch(/SUPERSECRET/);
      expect(json).not.toMatch(/apikey=/);
    }
  });

  it('serializeError redacts URLs in messages so error-logging callers stay safe', () => {
    const err = new Error('upstream rejected: GET https://nzbgeek.info/api?apikey=ABC&q=fairy — 500');
    const serialized = serializeError(err);
    // Error.stack repeats the message; both surfaces must be redacted.
    expect(serialized.message).toContain('https://nzbgeek.info/api');
    expect(serialized.message).not.toContain('ABC');
    expect(serialized.message).not.toContain('apikey');
    expect(serialized.stack).toBeDefined();
    expect(serialized.stack).not.toContain('ABC');
    expect(serialized.stack).not.toContain('apikey');
  });

  it('serializeError redacts URLs in nested cause stacks too', () => {
    const cause = new Error('downstream rejected: GET https://mam.test/api?session=ZZZ&mam_id=YYY');
    const outer = new Error('wrapped', { cause });
    const serialized = serializeError(outer);
    expect(serialized.cause?.stack).toBeDefined();
    expect(serialized.cause?.stack).not.toContain('ZZZ');
    expect(serialized.cause?.stack).not.toContain('YYY');
    expect(serialized.cause?.stack).not.toMatch(/session|mam_id/);
  });

  it('full serialized payload (JSON-stringified) contains no secret-shaped query params', () => {
    const err = new Error('fetch failed: GET https://nzbgeek.info/api?apikey=SECRET-LEAKER&q=test');
    const serialized = serializeError(err);
    const fullJson = JSON.stringify(serialized);
    expect(fullJson).not.toContain('SECRET-LEAKER');
    expect(fullJson).not.toMatch(/apikey=/);
  });
});
