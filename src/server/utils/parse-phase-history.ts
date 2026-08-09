import type { FastifyBaseLogger } from 'fastify';
import { phaseHistorySchema, type PhaseHistoryEntry } from '@shared/schemas/import-job.js';

/**
 * Malformed persisted history degrades to [] so hydration cannot 500. Never log parser
 * errors or raw values because JSON and Zod messages can echo them; log issue paths only.
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
  } catch {
    log.warn({ jobId }, 'Unparseable phaseHistory JSON; treating as empty');
    return [];
  }
  const result = phaseHistorySchema.safeParse(parsedJson);
  if (!result.success) {
    log.warn(
      { jobId, issuePaths: result.error.issues.map((i) => i.path.join('.')) },
      'Malformed phaseHistory; treating as empty',
    );
    return [];
  }
  return result.data;
}
