export function formatMergePhase(phase: string, percentage?: number, position?: number): string {
  switch (phase) {
    case 'queued':
      return position !== undefined ? `Queued (position ${position})` : 'Queued';
    case 'starting': return 'Merge started...';
    case 'staging': return 'Staging files...';
    case 'processing':
      return percentage !== undefined
        ? `Encoding to M4B — ${Math.round(percentage * 100)}%...`
        : 'Encoding to M4B...';
    case 'verifying': return 'Verifying output...';
    case 'committing': return 'Committing...';
    case 'complete': return 'Merge complete';
    case 'cancelled': return 'Merge cancelled';
    case 'failed': return 'Merge failed';
    default: return 'Merging...';
  }
}
