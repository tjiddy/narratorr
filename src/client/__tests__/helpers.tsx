import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function renderWithProviders(
  ui: React.ReactElement,
  { route = '/', queryClient, basename }: { route?: string; queryClient?: QueryClient; basename?: string } = {},
): RenderResult {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

  const initialRoute = basename ? `${basename}${route === '/' ? '' : route}` : route;

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialRoute]} {...(basename && { basename })}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
