import type { FastifyBaseLogger } from 'fastify';
import { phaseHistorySchema, type PhaseHistoryEntry } from '../../shared/schemas/import-job.js';
import { serializeError } from './serialize-error.js';

/**
 * Defensively parse a persisted `phaseHistory` JSON column.
 * On unparseable JSON or shape mismatch, logs a warn and returns `[]` so
 * listing/hydration paths cannot 500 on a malformed row.
 */
export function parsePhaseHistory(
  raw: string | null,
  log: FastifyBaseLogger,
  jobId: number,
): PhaseHistoryEntry[] {
  if (!raw) return [];
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error: unknown) {
    log.warn({ jobId, error: serializeError(error) }, 'Unparseable phaseHistory JSON; treating as empty');
    return [];
  }
  const result = phaseHistorySchema.safeParse(parsedJson);
  if (!result.success) {
    log.warn({ jobId, error: serializeError(result.error) }, 'Malformed phaseHistory; treating as empty');
    return [];
  }
  return result.data;
}
