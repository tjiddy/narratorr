import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { URL_BASE } from './lib/api/client';
import { applyInstanceBadge } from './lib/apply-instance-badge';
import './index.css';

// Recolor the favicon + prefix the tab title when this instance is badged (#1842).
// Fire-and-forget above all routes (incl. login) so it also applies pre-auth; non-fatal.
void applyInstanceBadge();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={URL_BASE || '/'}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
