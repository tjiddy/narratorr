import type { SearchDropReason } from '@shared/schemas/search-stream.js';

/** Exhaustive by construction: a new reason in the shared enum fails typecheck until copy exists. */
export const DROP_REASON_LABELS: Record<SearchDropReason, string> = {
  'blacklist-match': 'blacklisted',
  'reject-word-match': 'matched one of your reject words',
  'required-word-missing': 'missing one of your required words',
  'ebook-only-format': 'ebook-only, with no audio format',
  'below-min-seeders': 'below your minimum seeder count',
  'below-grab-floor': 'below your quality floor',
  'below-min-size': 'below your minimum size',
  'over-max-size': 'over your maximum size',
  'language-mismatch': 'not in one of your allowed languages',
};

/** A reason without a threshold renders bare — never a dangling "()". */
export function describeDropReason(reason: SearchDropReason, threshold?: string): string {
  const label = DROP_REASON_LABELS[reason];
  return threshold ? `${label} (${threshold})` : label;
}
