/**
 * Convert a stored bps bitrate to kbps, returning `undefined` for null/undefined and for any
 * value that floors below 1 kbps.
 *
 * The sub-1-kbps arm is a *value-sanity* guarantee, not a policy threshold: "0 kbps" is not a
 * bitrate at any layer, and the repository's known garbage class (an MP3 header reporting 827
 * bps) would otherwise reach the core processor as a numeric `0`. Deciding what counts as
 * *usable evidence* stays single-homed in the core encode-strategy resolver, which rejects
 * anything below its own plausibility floor — a 1–7 kbps value that passes here is rejected
 * there.
 */
export function toSourceBitrateKbps(bps: number | null | undefined): number | undefined {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return undefined;
  const kbps = Math.floor(bps / 1000);
  return kbps >= 1 ? kbps : undefined;
}
