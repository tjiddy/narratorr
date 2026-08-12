// Machine evidence paired with human reason text; clients must not parse prose.
// mismatch means both runtimes disagree, missing means the edition lacks one, and
// no-data means the scan has none. Other review rows omit reasonKind.
export type MatchReasonKind = 'duration-mismatch' | 'missing-duration' | 'no-duration-data';
