import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorReason } from '@core/connectors/types.js';
import type { ConnectorService } from '../services/connector.service.js';
import type { RetagResult } from '../services/tagging.service.js';
import { fireAndForget } from './fire-and-forget.js';

export interface BookRefreshItem {
  bookId: number;
  title: string;
  authorName?: string | null;
  libraryPath: string;
}

// Connector refreshes never block or fail the mutation that triggered them.
export function enqueueBookRefresh(
  connectorService: ConnectorService | undefined,
  log: FastifyBaseLogger,
  reason: ConnectorReason,
  book: BookRefreshItem,
): void {
  if (!connectorService) return;
  fireAndForget(
    connectorService.notifyRefresh(reason, [book]),
    log,
    `Failed to enqueue connector refresh (${reason})`,
  );
}

// Use the pre-mutation item so a post-retag reload failure cannot drop the refresh.
export function enqueueRetagRefresh(
  connectorService: ConnectorService | undefined,
  log: FastifyBaseLogger,
  result: RetagResult,
): void {
  if (result.tagged > 0 && result.refreshItem) {
    enqueueBookRefresh(connectorService, log, 'metadata', result.refreshItem);
  }
}
