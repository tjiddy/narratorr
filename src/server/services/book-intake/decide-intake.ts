import type { DuplicateResolution } from '../book-dedup.js';
import { buildDuplicateCandidate } from './candidate.js';
import type { IntakeDecision, IntakeDeps, IntakeRequest } from './types.js';

/** Widen a resolution into the decision union without losing anything. `hasIncumbent` survives on
 * the admit arm because both different-recording producers return a null book, and the hydrated
 * row survives because downstream callers need more of it than the id. */
function toIntakeDecision(resolution: DuplicateResolution): IntakeDecision {
  const existingBookId = resolution.book?.id ?? null;
  if (resolution.verdict === 'same-recording') {
    return { kind: 'same-recording', incumbent: resolution.book, existingBookId };
  }
  if (resolution.verdict === 'review') {
    return {
      kind: 'review',
      incumbent: resolution.book,
      existingBookId,
      ...(resolution.recordingReviewReason !== undefined && {
        recordingReviewReason: resolution.recordingReviewReason,
      }),
    };
  }
  return { kind: 'admit', hasIncumbent: resolution.hasIncumbent };
}

/** The single home of the duplicate/recording decision for read-only and classification callers.
 *
 * Always queries: there is no bypass axis, so every decision it returns is a real observation and
 * the union cannot carry a value the module invented. Bypass stays a caller concern — short-circuit
 * before calling this. Errors propagate untouched; each caller owns its own failure policy, and
 * this performs no provider I/O and no logging of its own. */
export async function decideIntake(deps: IntakeDeps, request: IntakeRequest): Promise<IntakeDecision> {
  const resolution = await deps.bookService.findDuplicate(buildDuplicateCandidate(request.item));
  return toIntakeDecision(resolution);
}
