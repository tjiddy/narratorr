/** Describes foreign files preserved by managed-audio deletion; empty when none remain. */
const MAX_NAMES = 3;

export function describeKeptFiles(preservedForeign: string[] | undefined): string {
  if (!preservedForeign || preservedForeign.length === 0) return '';
  const count = preservedForeign.length;
  const names = preservedForeign.slice(0, MAX_NAMES).join(', ');
  const overflow = count > MAX_NAMES ? `, +${count - MAX_NAMES} more` : '';
  return `kept ${count} non-audio file${count !== 1 ? 's' : ''} (${names}${overflow})`;
}
