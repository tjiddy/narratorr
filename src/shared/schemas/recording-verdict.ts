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
