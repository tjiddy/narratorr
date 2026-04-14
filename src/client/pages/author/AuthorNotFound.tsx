import { BookOpenIcon } from '@/components/icons';
import { NotFoundState } from '@/components/NotFoundState.js';

export function AuthorNotFound() {
  return (
    <NotFoundState
      icon={BookOpenIcon}
      title="Author not found"
      subtitle="The author you're looking for doesn't exist or couldn't be loaded."
      backTo="/library"
      backLabel="Back to Library"
    />
  );
}
