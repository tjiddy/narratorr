export function formatProgress(progress: number): string {
  return `${Math.round(progress * 100)}%`;
}
