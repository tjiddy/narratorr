import { z } from 'zod';

// ============================================================================
// Recording-identity verdict — canonical source for the 3-way verdict enum
// (#1741). Derives the Zod enum and the TS union type from one `as const`
// tuple so the shared schema (`library-scan.ts`), the server/client
// `MatchResult`, and the core resolver (`recording-identity.ts`, which
// re-exports the type) can never drift apart. Mirrors the
// `download-protocol.ts` PROTOCOLS / protocolSchema / DownloadProtocol shape.
// ============================================================================

export const recordingVerdictValues = ['same-recording', 'different-recording', 'review'] as const;
export const recordingVerdictSchema = z.enum(recordingVerdictValues);
export type RecordingVerdict = (typeof recordingVerdictValues)[number];

// ============================================================================
// Recording-review reason — the MACHINE reason a `review` verdict was reached
// (#1728). Distinct from the user-facing display string `reviewReason`
// (`library-scan.ts`, rendered in `ImportCard.tsx`): this is a structured enum
// the resolver emits and callers log/record, never tooltip text. Declared once
// here, beside the verdict tuple, so every surface (resolver result,
// `DuplicateResolution`, import-list event JSON, post-match log context) shares
// one source of truth and the production-type veto predicate lives in exactly
// one place (the resolver).
//
//  - `narrator-no-signal`      — equal title/author but narrators carry no
//                                comparable signal (placeholder/empty).
//  - `duration-mismatch`       — equal narrators, both durations present, beyond
//                                the tolerance band.
//  - `production-type-mismatch`— equal narrators, duration cannot corroborate
//                                (missing/zero), and both production forms are
//                                known and different (e.g. unabridged vs abridged).
// ============================================================================

export const recordingReviewReasonValues = ['narrator-no-signal', 'duration-mismatch', 'production-type-mismatch'] as const;
export const recordingReviewReasonSchema = z.enum(recordingReviewReasonValues);
export type RecordingReviewReason = (typeof recordingReviewReasonValues)[number];
