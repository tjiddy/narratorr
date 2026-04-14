import { ErrorState } from '@/components/ErrorState.js';

export function LibraryErrorState() {
  return (
    <ErrorState
      title="Something went wrong"
      description="Failed to load your library. Please try again."
      data-testid="library-error"
    />
  );
}
