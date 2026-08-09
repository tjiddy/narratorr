// Missing rowsAffected is a driver/version contract violation, not a zero-row result.
export function getRowsAffected(result: unknown): number {
  const rowsAffected = (result as { rowsAffected?: unknown } | null | undefined)?.rowsAffected;
  if (typeof rowsAffected !== 'number') {
    throw new Error(
      `getRowsAffected: rowsAffected missing or non-numeric on Drizzle result (got ${typeof rowsAffected})`,
    );
  }
  return rowsAffected;
}
