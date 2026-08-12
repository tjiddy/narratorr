// Use for values from fallible lookups, not structurally safe values.
export function requireDefined<T>(value: T | undefined | null, msg: string): T {
  if (value === undefined || value === null) throw new Error(msg);
  return value;
}
