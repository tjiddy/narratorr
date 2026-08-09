/** Parse a finite numeric attr; missing, blank, garbage, and non-finite values are absent. */
export function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
