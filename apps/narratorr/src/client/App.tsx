import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from './components/layout/Layout';
import { LibraryPage } from './pages/LibraryPage';
import { SearchPage } from './pages/SearchPage';
import { ActivityPage } from './pages/activity';
import { BookPage } from './pages/book';
import { AuthorPage } from './pages/AuthorPage';
import { ManualImportPage } from './pages/manual-import';
import {
  SettingsLayout,
  GeneralSettings,
  IndexersSettings,
  DownloadClientsSettings,
  NotificationsSettings,
  BlacklistSettings,
} from './pages/settings';

export function App() {
  return (
    <>
      <Toaster position="bottom-right" richColors theme="system" />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/library" replace />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="import" element={<ManualImportPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="books/:id" element={<BookPage />} />
          <Route path="authors/:asin" element={<AuthorPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<GeneralSettings />} />
            <Route path="indexers" element={<IndexersSettings />} />
            <Route path="download-clients" element={<DownloadClientsSettings />} />
            <Route path="notifications" element={<NotificationsSettings />} />
            <Route path="blacklist" element={<BlacklistSettings />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}
