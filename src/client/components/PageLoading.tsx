import type { ReactNode } from 'react';
import { LoadingSpinner } from './icons';

interface PageLoadingProps {
  header?: ReactNode;
}

export function PageLoading({ header }: PageLoadingProps) {
  return (
    <div className="space-y-6">
      {header}
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    </div>
  );
}
