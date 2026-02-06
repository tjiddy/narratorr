import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from './components/layout/Layout';
import { SearchPage } from './pages/SearchPage';
import { ActivityPage } from './pages/ActivityPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <>
      <Toaster position="bottom-right" richColors theme="system" />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/search" replace />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings/*" element={<SettingsPage />} />
        </Route>
      </Routes>
    </>
  );
}
