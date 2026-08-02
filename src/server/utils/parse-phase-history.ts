import type { FastifyBaseLogger } from 'fastify';
import { phaseHistorySchema, type PhaseHistoryEntry } from '@shared/schemas/import-job.js';

/**
 * Defensively parse a persisted `phaseHistory` JSON column.
 * On unparseable JSON or shape mismatch, logs a warn and returns `[]` so
 * listing/hydration paths cannot 500 on a malformed row.
 *
 * **Neither warn carries the persisted value.** Both arms used to pass the caught
 * error through `serializeError`, which copies `message`/`stack` and redacts only
 * URLs — and both of those messages can embed the stored content: V8's
 * `SyntaxError` quotes a snippet of the offending source
 * (`JSON.parse('{"a": bad}')` → `Unexpected token 'b', "{"a": bad}" is not valid
 * JSON`), and a `ZodError` message renders the `received` values. `jobId` plus the
 * failing issue PATHS are the whole diagnostic need; the row is inspected out of
 * band. Same rule and same shape as `parseClearedFields` (#2069 AC4) and the
 * quality-gate reason parser (#1404), which is the precedent for logging Zod paths
 * without values.
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
