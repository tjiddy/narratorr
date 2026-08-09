// Reject values that floor to zero here; encode strategy owns the higher plausibility threshold.
export function toSourceBitrateKbps(bps: number | null | undefined): number | undefined {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return undefined;
  const kbps = Math.floor(bps / 1000);
  return kbps >= 1 ? kbps : undefined;
}
