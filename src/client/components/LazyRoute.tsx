import { Suspense } from 'react';
import { LoadingSpinner } from './icons';
import { RouteErrorBoundary } from './RouteErrorBoundary';

export function PageFallback() {
  return (
    <div className="flex items-center justify-center py-32">
      <LoadingSpinner className="w-8 h-8 text-muted-foreground" />
    </div>
  );
}

export function LazyRoute({ children }: { children: React.ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        {children}
      </Suspense>
    </RouteErrorBoundary>
  );
}
