import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManualAddFormModal } from './ManualAddFormModal';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      addBook: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        quality: { searchImmediately: true, monitorForUpgrades: false },
      }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('ManualAddFormModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AC4 — aria-labelledby', () => {
    it('dialog element has aria-labelledby attribute referencing the form heading', () => {
      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={vi.fn()} />,
      );

      const dialog = screen.getByRole('dialog');
      const labelledById = dialog.getAttribute('aria-labelledby');
      expect(labelledById).toBeTruthy();

      const heading = document.getElementById(labelledById!);
      expect(heading).not.toBeNull();
      expect(heading!.textContent).toBe('Add manually');
    });

    it('heading text matches expected title', () => {
      renderWithQuery(
        <ManualAddFormModal isOpen={true} onClose={vi.fn()} />,
      );

      const heading = screen.getByRole('heading', { name: 'Add manually' });
      expect(heading).toBeInTheDocument();
      expect(heading.id).toBeTruthy();
    });
  });
});
