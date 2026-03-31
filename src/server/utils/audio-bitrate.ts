import type { FastifyBaseLogger } from 'fastify';

/** Convert bps to kbps, returning undefined for null/0/undefined values. */
export function toSourceBitrateKbps(bps: number | null | undefined): number | undefined {
  return bps ? Math.floor(bps / 1000) : undefined;
}

/** Log a capping warning when source bitrate is below target. Returns both values unchanged. */
export function logBitrateCapping(
  sourceBitrateKbps: number | undefined,
  targetBitrateKbps: number | undefined,
  log: FastifyBaseLogger,
): { sourceBitrateKbps: number | undefined; targetBitrateKbps: number | undefined } {
  if (targetBitrateKbps != null && sourceBitrateKbps != null && sourceBitrateKbps < targetBitrateKbps) {
    log.debug(
      { sourceBitrateKbps, targetBitrateKbps, effectiveBitrateKbps: sourceBitrateKbps },
      'Capping target bitrate to source bitrate to prevent upsampling',
    );
  }
  return { sourceBitrateKbps, targetBitrateKbps };
}
