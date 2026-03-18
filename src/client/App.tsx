import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './components/AuthProvider';
import { Layout } from './components/layout/Layout';
import { LoginPage } from './pages/login';
import { LibraryPage } from './pages/library';
import { SearchPage } from './pages/search';
import { ActivityPage } from './pages/activity';
import { DiscoverPage } from './pages/discover';
import { BookPage } from './pages/book';
import { AuthorPage } from './pages/author';
import { ManualImportPage } from './pages/manual-import';
import { SettingsLayout } from './pages/settings';
import { settingsPageRegistry } from './pages/settings/registry';

export function App() {
  return (
    <>
      <Toaster position="bottom-right" richColors theme="system" />
      <AuthProvider>
        <Routes>
          {/* Login page — rendered outside the Layout shell */}
          <Route path="/login" element={<LoginPage />} />

          {/* Protected routes — wrapped in Layout */}
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/library" replace />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="import" element={<ManualImportPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="discover" element={<DiscoverPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="books/:id" element={<BookPage />} />
            <Route path="authors/:asin" element={<AuthorPage />} />
            <Route path="settings" element={<SettingsLayout />}>
              {settingsPageRegistry.map((entry) => {
                const Component = entry.component;
                return entry.path === '' ? (
                  <Route key="index" index element={<Component />} />
                ) : (
                  <Route key={entry.path} path={entry.path} element={<Component />} />
                );
              })}
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </>
  );
}
