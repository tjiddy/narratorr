import type { FastifyBaseLogger } from 'fastify';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import { retrySearch, type RetrySearchDeps } from './retry-search.js';
import type { BlacklistReason } from '@shared/schemas/blacklist.js';
import { serializeError } from '../utils/serialize-error.js';


export interface BlacklistIdentifiers {
  infoHash?: string | undefined;
  guid?: string | undefined;
  title: string;
  bookId?: number | undefined;
}

export interface BlacklistAndRetryRequest {
  identifiers: BlacklistIdentifiers;
  reason: BlacklistReason;
  book: { id: number } | null;
  blacklistService?: BlacklistService | undefined;
  retrySearchDeps?: RetrySearchDeps | undefined;
  settingsService?: SettingsService | undefined;
  log: FastifyBaseLogger;
  /** When true, bypass the redownloadFailed setting and always trigger retry search. */
  overrideRetry?: boolean | undefined;
  /** Defaults to permanent. */
  blacklistType?: 'temporary' | 'permanent' | undefined;
}

/** Blacklist and optionally re-search; callers retain ownership of file deletion. */
export async function blacklistAndRetrySearch(request: BlacklistAndRetryRequest): Promise<void> {
  const { identifiers, reason, book, blacklistService, retrySearchDeps, settingsService, log, overrideRetry, blacklistType } = request;

  if ((identifiers.infoHash || identifiers.guid) && blacklistService) {
    try {
      await blacklistService.create({
        infoHash: identifiers.infoHash,
        guid: identifiers.guid,
        title: identifiers.title,
        bookId: identifiers.bookId,
        reason,
        ...(blacklistType ? { blacklistType } : {}),
      });
      log.info({ infoHash: identifiers.infoHash, guid: identifiers.guid }, 'Blacklisted rejected release');
    } catch (error: unknown) {
      log.warn({ error: serializeError(error) }, 'Failed to blacklist release');
    }
  } else if (!identifiers.infoHash && !identifiers.guid) {
    log.info('Blacklist skipped — no infoHash or guid');
  }

  if (!book || !retrySearchDeps) {
    return;
  }

  const deps = retrySearchDeps;
  const bookId = book.id;

  // User-requested retries must not depend on a settings read.
  if (overrideRetry) {
    log.info({ bookId }, 'Triggering re-search after reject');
    retrySearch(bookId, deps).catch((error: unknown) => {
      log.warn({ bookId, error: serializeError(error) }, 'Re-search after reject failed');
    });
    return;
  }

  if (!settingsService) return;
  settingsService.get('import').then((importSettings) => {
    if (importSettings.redownloadFailed) {
      log.info({ bookId }, 'Triggering re-search after reject');
      retrySearch(bookId, deps).catch((error: unknown) => {
        log.warn({ bookId, error: serializeError(error) }, 'Re-search after reject failed');
      });
    }
  }).catch((error: unknown) => {
    log.warn({ error: serializeError(error) }, 'Failed to check redownloadFailed setting');
  });
}
