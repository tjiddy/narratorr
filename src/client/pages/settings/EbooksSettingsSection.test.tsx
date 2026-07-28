import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { createMockSettings } from '@/__tests__/factories';
import { EbooksSettingsSection } from './EbooksSettingsSection';

vi.mock('@/lib/api', () => ({
  api: { getSettings: vi.fn(), updateSettings: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as { success: ReturnType<typeof vi.fn> };

// The exact class string HealthDashboard.tsx uses for an external doc link (AC10).
// Asserted with string EQUALITY, never toHaveClass — a subset check passes on a partial copy.
const HEALTH_LINK_CLASS =
  'inline-block text-xs font-medium mt-1 text-primary hover:text-primary/80 underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 transition-colors';

const DOCS_URL = 'https://docs.narratorr.dev/narratorr-requests/';

const INFO_TIP_BODY =
  "Ebooks need to already be in the book's folder. Narratorr doesn't search for or download them. "
  + 'Enabling this also exposes them over the API, which is how Narratorr Requests offers Download '
  + 'and Send to Kindle to your family.';

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getSettings.mockResolvedValue(createMockSettings());
  mockApi.updateSettings.mockResolvedValue(createMockSettings({ companionEpub: { enabled: true } }));
});

async function renderSection(queryClient?: QueryClient) {
  renderWithProviders(<EbooksSettingsSection />, queryClient ? { queryClient } : {});
  await waitFor(() => {
    expect(screen.getByLabelText('Enable ebook support')).toBeInTheDocument();
  });
}

describe('EbooksSettingsSection', () => {
  it('renders with the toggle off from the default settings', async () => {
    await renderSection();
    expect(screen.getByLabelText('Enable ebook support')).not.toBeChecked();
  });

  it('toggling and submitting sends exactly the companionEpub payload, with no sibling categories', async () => {
    await renderSection();

    await userEvent.click(screen.getByLabelText('Enable ebook support'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ companionEpub: { enabled: true } });
    });
    expect(mockApi.updateSettings).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // AC9a — the six feature-unique strings, one assertion each, verbatim.
  // ---------------------------------------------------------------------------
  describe('feature-unique copy', () => {
    it('renders the section title', async () => {
      await renderSection();
      expect(screen.getByRole('heading', { name: 'Ebooks' })).toBeInTheDocument();
    });

    it('renders the section description', async () => {
      await renderSection();
      expect(screen.getByText("Show ebooks you've stored alongside your audiobooks.")).toBeInTheDocument();
    });

    it('renders the row label', async () => {
      await renderSection();
      expect(screen.getByText('Enable ebook support')).toBeInTheDocument();
    });

    it('renders the row description', async () => {
      await renderSection();
      expect(
        screen.getByText('Show ebooks stored alongside your audiobooks, ready to download from the book page.'),
      ).toBeInTheDocument();
    });

    it('renders the InfoTip body when the tip is opened', async () => {
      await renderSection();
      await userEvent.click(screen.getByRole('button', { name: 'More info' }));
      const tip = await screen.findByRole('tooltip');
      expect(tip.textContent?.replace(/\s+/g, ' ').trim()).toBe(INFO_TIP_BODY);
    });

    it('shows the success toast after a save', async () => {
      await renderSection();
      await userEvent.click(screen.getByLabelText('Enable ebook support'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith('Ebook settings saved');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // AC9b — the inherited strings, asserted as inherited (never re-authored).
  // ---------------------------------------------------------------------------
  describe('inherited copy', () => {
    it('renders no submit button while the form is clean', async () => {
      await renderSection();
      expect(screen.queryAllByRole('button', { name: /save/i })).toHaveLength(0);
    });

    it("names the dirty submit button exactly 'Save' — not a feature-specific label", async () => {
      await renderSection();
      await userEvent.click(screen.getByLabelText('Enable ebook support'));
      const button = screen.getByRole('button', { name: /save/i });
      expect(button).toHaveAccessibleName('Save');
    });

    it("names the in-flight submit button exactly 'Saving...' and disables it", async () => {
      let resolveUpdate: (value: unknown) => void = () => {};
      mockApi.updateSettings.mockImplementation(() => new Promise((resolve) => { resolveUpdate = resolve; }));
      await renderSection();

      await userEvent.click(screen.getByLabelText('Enable ebook support'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      const pending = await screen.findByRole('button', { name: 'Saving...' });
      expect(pending).toBeDisabled();
      resolveUpdate(createMockSettings({ companionEpub: { enabled: true } }));
    });

    it("uses the InfoTip component's own default accessible name, proving the label prop was not overridden", async () => {
      await renderSection();
      expect(screen.getByRole('button', { name: 'More info' })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // #1963 AC2 — a successful save evicts every cached Ebook-panel observation.
  //
  // Behaviour-only: nothing the owner sees in this section changes, and every existing
  // assertion above still holds unchanged. Direction-independent by design, so a
  // direction-branching implementation fails the "turns it off" case.
  // ---------------------------------------------------------------------------
  describe('companion-ebook cache eviction on save', () => {
    const CACHED = { status: 'available' as const, filename: 'a.epub', sizeBytes: 10, validationCode: null, candidateCount: 0, selectedFilename: 'a.epub', candidates: [] };

    function seedClient(): QueryClient {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(queryKeys.companionEbook(1), CACHED);
      client.setQueryData(queryKeys.companionEbook(2), CACHED);
      client.setQueryData(queryKeys.bookFiles(1), [{ name: 'a.m4b', size: 1 }]);
      return client;
    }

    async function saveToggle(client: QueryClient) {
      await renderSection(client);
      await userEvent.click(screen.getByLabelText('Enable ebook support'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    }

    it('drops every companion entry when the toggle is turned on, leaving unrelated keys alone', async () => {
      const client = seedClient();
      await saveToggle(client);

      await waitFor(() => expect(client.getQueryData(queryKeys.companionEbook(1))).toBeUndefined());
      expect(client.getQueryData(queryKeys.companionEbook(2))).toBeUndefined();
      expect(client.getQueryData(queryKeys.bookFiles(1))).toEqual([{ name: 'a.m4b', size: 1 }]);
    });

    it('drops them when the toggle is turned off too', async () => {
      mockApi.getSettings.mockResolvedValue(createMockSettings({ companionEpub: { enabled: true } }));
      mockApi.updateSettings.mockResolvedValue(createMockSettings({ companionEpub: { enabled: false } }));
      const client = seedClient();
      await renderSection(client);
      await waitFor(() => expect(screen.getByLabelText('Enable ebook support')).toBeChecked());

      await userEvent.click(screen.getByLabelText('Enable ebook support'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ companionEpub: { enabled: false } }));
      await waitFor(() => expect(client.getQueryData(queryKeys.companionEbook(1))).toBeUndefined());
      expect(client.getQueryData(queryKeys.companionEbook(2))).toBeUndefined();
      expect(client.getQueryData(queryKeys.bookFiles(1))).toEqual([{ name: 'a.m4b', size: 1 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // AC10 / AC11
  // ---------------------------------------------------------------------------
  describe('the docs link and the copy rules', () => {
    it('points at the docs URL, opens safely, and carries the HealthDashboard class string exactly', async () => {
      await renderSection();
      await userEvent.click(screen.getByRole('button', { name: 'More info' }));

      const link = await screen.findByRole('link', { name: 'Narratorr Requests' });
      expect(link).toHaveAttribute('href', DOCS_URL);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.getAttribute('class')).toBe(HEALTH_LINK_CLASS);
    });

    it('renders no em-dash and never the word "companion", in visible text OR accessible names', async () => {
      const { container } = renderWithProviders(<EbooksSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Enable ebook support')).toBeInTheDocument();
      });
      await userEvent.click(screen.getByRole('button', { name: 'More info' }));

      const visible = container.textContent ?? '';
      expect(visible).not.toContain('—');
      expect(visible.toLowerCase()).not.toContain('companion');

      // Accessible names are where a customised aria-label would smuggle banned vocabulary
      // past a visible-text sweep.
      const accessibleNames = Array.from(container.querySelectorAll('[aria-label], [title], [alt]'))
        .map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('alt') ?? ''}`)
        .join(' ');
      expect(accessibleNames).not.toContain('—');
      expect(accessibleNames.toLowerCase()).not.toContain('companion');
    });
  });
});
