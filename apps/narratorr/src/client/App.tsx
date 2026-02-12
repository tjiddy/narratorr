import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from './components/layout/Layout';
import { LibraryPage } from './pages/LibraryPage';
import { SearchPage } from './pages/SearchPage';
import { ActivityPage } from './pages/ActivityPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <>
      <Toaster position="bottom-right" richColors theme="system" />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/library" replace />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings/*" element={<SettingsPage />} />
        </Route>
      </Routes>
    </>
  );
}
