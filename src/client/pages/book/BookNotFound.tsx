import { BookOpenIcon } from '@/components/icons';
import { NotFoundState } from '@/components/NotFoundState.js';

export function BookNotFound() {
  return (
    <NotFoundState
      icon={BookOpenIcon}
      title="Book not found"
      subtitle="The book you're looking for doesn't exist or couldn't be loaded."
      backTo="/library"
      backLabel="Back to Library"
    />
  );
}
