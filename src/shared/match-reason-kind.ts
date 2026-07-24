/**
 * Structured discriminator for the three duration-confidence Review reasons the
 * match job emits (#1929). Paired with — never parsed from — the human `reason`
 * display string, so the client re-pick logic can branch on the *evidence class*
 * without string-matching the wording:
 *
 *  - `duration-mismatch` — scanned runtime present, picked/best-match edition
 *    runtime present, and the two are out of the shared tolerance band.
 *  - `missing-duration` — duration evidence is incomplete on ONE side (the
 *    best-match/picked edition has no positive runtime); cannot verify.
 *  - `no-duration-data` — no scanned runtime at all; pure match-identity
 *    ambiguity, resolvable by an explicit operator re-pick.
 *
 * Attempt-cap / narrator-cap / legacy medium rows carry NO `reasonKind`
 * (`undefined`) and route to the legacy re-pick branch. Hand-mirrored between the
 * server `MatchResult` (`match-job.types.ts`) and the client twin
 * (`lib/api/library-scan.ts`) — no Zod schema, matching the un-validated
 * match-job status contract.
 */
export type MatchReasonKind = 'duration-mismatch' | 'missing-duration' | 'no-duration-data';
