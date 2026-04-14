import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './components/AuthProvider';
import { Layout } from './components/layout/Layout';
import { LoadingSpinner } from './components/icons';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';

const LoginPage = lazy(() => import('./pages/login').then(m => ({ default: m.LoginPage })));
const LibraryPage = lazy(() => import('./pages/library').then(m => ({ default: m.LibraryPage })));
const SearchPage = lazy(() => import('./pages/search').then(m => ({ default: m.SearchPage })));
const ActivityPage = lazy(() => import('./pages/activity').then(m => ({ default: m.ActivityPage })));
const DiscoverPage = lazy(() => import('./pages/discover').then(m => ({ default: m.DiscoverPage })));
const BookPage = lazy(() => import('./pages/book').then(m => ({ default: m.BookPage })));
const AuthorPage = lazy(() => import('./pages/author').then(m => ({ default: m.AuthorPage })));
const ManualImportPage = lazy(() => import('./pages/manual-import').then(m => ({ default: m.ManualImportPage })));
const LibraryImportPage = lazy(() => import('./pages/library-import/LibraryImportPage.js').then(m => ({ default: m.LibraryImportPage })));
const SettingsLayout = lazy(() => import('./pages/settings').then(m => ({ default: m.SettingsLayout })));

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-32">
      <LoadingSpinner className="w-8 h-8 text-muted-foreground" />
    </div>
  );
}

function LazyRoute({ children }: { children: React.ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        {children}
      </Suspense>
    </RouteErrorBoundary>
  );
}

export function App() {
  return (
    <>
      <Toaster position="bottom-right" richColors theme="system" />
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LazyRoute><LoginPage /></LazyRoute>} />

          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/library" replace />} />
            <Route path="library" element={<LazyRoute><LibraryPage /></LazyRoute>} />
            <Route path="import" element={<LazyRoute><ManualImportPage /></LazyRoute>} />
            <Route path="library-import" element={<LazyRoute><LibraryImportPage /></LazyRoute>} />
            <Route path="search" element={<LazyRoute><SearchPage /></LazyRoute>} />
            <Route path="discover" element={<LazyRoute><DiscoverPage /></LazyRoute>} />
            <Route path="activity" element={<LazyRoute><ActivityPage /></LazyRoute>} />
            <Route path="books/:id" element={<LazyRoute><BookPage /></LazyRoute>} />
            <Route path="authors/:asin" element={<LazyRoute><AuthorPage /></LazyRoute>} />
            <Route path="settings/*" element={<LazyRoute><SettingsLayout /></LazyRoute>} />
          </Route>
        </Routes>
      </AuthProvider>
    </>
  );
}
