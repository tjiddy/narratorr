import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderSettings } from './ImportListProviderSettings';

vi.mock('@/lib/api', () => ({
  api: {
    fetchAbsLibraries: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function StatefulProvider({
  type,
  initial = {},
  onChangeSpy,
}: {
  type: string;
  initial?: Record<string, unknown>;
  onChangeSpy?: (next: Record<string, unknown>) => void;
}) {
  const [settings, setSettings] = useState<Record<string, unknown>>(initial);
  return (
    <ProviderSettings
      type={type}
      settings={settings}
      onChange={(next) => {
        setSettings(next);
        onChangeSpy?.(next);
      }}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProviderSettings', () => {
  describe('type dispatching', () => {
    it('renders the ABS sub-tree for type="abs"', () => {
      render(<ProviderSettings type="abs" settings={{}} onChange={vi.fn()} />);

      expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
      expect(screen.getByLabelText('Library')).toBeInTheDocument();
      expect(screen.queryByLabelText('Bestseller List')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('List Type')).not.toBeInTheDocument();
    });

    it('renders the NYT sub-tree for type="nyt"', () => {
      render(<ProviderSettings type="nyt" settings={{}} onChange={vi.fn()} />);

      expect(screen.getByLabelText('Bestseller List')).toBeInTheDocument();
      expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('List Type')).not.toBeInTheDocument();
    });

    it('renders the Hardcover sub-tree for type="hardcover"', () => {
      render(<ProviderSettings type="hardcover" settings={{}} onChange={vi.fn()} />);

      expect(screen.getByLabelText('List Type')).toBeInTheDocument();
      expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Bestseller List')).not.toBeInTheDocument();
    });

    it('returns null for an unknown type', () => {
      const { container } = render(
        <ProviderSettings type="unknown" settings={{}} onChange={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('AbsSettings branches', () => {
    it('shows the guard error and does not call the API when serverUrl is empty', async () => {
      const user = userEvent.setup();
      render(
        <ProviderSettings type="abs" settings={{ apiKey: 'k' }} onChange={vi.fn()} />,
      );

      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      expect(screen.getByText('Enter server URL and API key first')).toBeInTheDocument();
      expect(api.fetchAbsLibraries).not.toHaveBeenCalled();
    });

    it('shows the guard error and does not call the API when apiKey is empty', async () => {
      const user = userEvent.setup();
      render(
        <ProviderSettings
          type="abs"
          settings={{ serverUrl: 'http://abs.local' }}
          onChange={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      expect(screen.getByText('Enter server URL and API key first')).toBeInTheDocument();
      expect(api.fetchAbsLibraries).not.toHaveBeenCalled();
    });

    it('replaces the library text input with a populated SelectWithChevron on successful non-empty fetch', async () => {
      (api.fetchAbsLibraries as Mock).mockResolvedValue({
        libraries: [
          { id: 'lib-1', name: 'Audiobooks' },
          { id: 'lib-2', name: 'Podcasts' },
        ],
      });
      const user = userEvent.setup();
      render(
        <ProviderSettings
          type="abs"
          settings={{ serverUrl: 'http://abs.local', apiKey: 'k' }}
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByLabelText('Library').tagName).toBe('INPUT');

      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      await waitFor(() => {
        expect(screen.getByLabelText('Library').tagName).toBe('SELECT');
      });
      const select = screen.getByLabelText('Library') as HTMLSelectElement;
      expect(select.options).toHaveLength(3);
      expect(screen.getByRole('option', { name: 'Audiobooks' })).toHaveAttribute('value', 'lib-1');
      expect(screen.getByRole('option', { name: 'Podcasts' })).toHaveAttribute('value', 'lib-2');
    });

    it('shows "No libraries found" when the fetch resolves with an empty libraries array', async () => {
      (api.fetchAbsLibraries as Mock).mockResolvedValue({ libraries: [] });
      const user = userEvent.setup();
      render(
        <ProviderSettings
          type="abs"
          settings={{ serverUrl: 'http://abs.local', apiKey: 'k' }}
          onChange={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      await waitFor(() => {
        expect(screen.getByText('No libraries found')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Library').tagName).toBe('INPUT');
    });

    it('shows "Failed to fetch libraries" when the API rejects', async () => {
      (api.fetchAbsLibraries as Mock).mockRejectedValue(new Error('network'));
      const user = userEvent.setup();
      render(
        <ProviderSettings
          type="abs"
          settings={{ serverUrl: 'http://abs.local', apiKey: 'k' }}
          onChange={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      await waitFor(() => {
        expect(screen.getByText('Failed to fetch libraries')).toBeInTheDocument();
      });
    });

    it('flips the fetch button to "Fetching..." disabled during the in-flight call and restores after resolution', async () => {
      let resolveFetch!: (value: { libraries: Array<{ id: string; name: string }> }) => void;
      const pending = new Promise<{ libraries: Array<{ id: string; name: string }> }>((resolve) => {
        resolveFetch = resolve;
      });
      (api.fetchAbsLibraries as Mock).mockReturnValue(pending);
      const user = userEvent.setup();
      render(
        <ProviderSettings
          type="abs"
          settings={{ serverUrl: 'http://abs.local', apiKey: 'k' }}
          onChange={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Fetch Libraries' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Fetching...' })).toBeDisabled();
      });

      await act(async () => {
        resolveFetch({ libraries: [{ id: 'lib-1', name: 'Audiobooks' }] });
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Fetch Libraries' })).not.toBeDisabled();
      });
    });

    it('typing into Server URL fires onChange with the merged settings object', async () => {
      const spy = vi.fn();
      const user = userEvent.setup();
      render(<StatefulProvider type="abs" initial={{ apiKey: 'k' }} onChangeSpy={spy} />);

      await user.type(screen.getByLabelText('Server URL'), 'h');

      expect(spy).toHaveBeenCalledWith({ apiKey: 'k', serverUrl: 'h' });
    });

    it('typing into API Key fires onChange with the merged settings object', async () => {
      const spy = vi.fn();
      const user = userEvent.setup();
      render(
        <StatefulProvider
          type="abs"
          initial={{ serverUrl: 'http://abs.local' }}
          onChangeSpy={spy}
        />,
      );

      await user.type(screen.getByLabelText('API Key'), 'x');

      expect(spy).toHaveBeenCalledWith({ serverUrl: 'http://abs.local', apiKey: 'x' });
    });
  });

  describe('NytSettings branches', () => {
    it('renders API Key and defaults Bestseller List to "audio-fiction" when settings.list is absent', () => {
      render(<ProviderSettings type="nyt" settings={{}} onChange={vi.fn()} />);

      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
      expect((screen.getByLabelText('Bestseller List') as HTMLSelectElement).value).toBe(
        'audio-fiction',
      );
    });

    it('selecting a different list option calls onChange with the new list value', async () => {
      const spy = vi.fn();
      const user = userEvent.setup();
      render(<StatefulProvider type="nyt" onChangeSpy={spy} />);

      await user.selectOptions(screen.getByLabelText('Bestseller List'), 'audio-nonfiction');

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ list: 'audio-nonfiction' }));
    });
  });

  describe('HardcoverSettings branches', () => {
    it('renders API Key and List Type; Shelf ID is absent when listType defaults to "trending"', () => {
      render(<ProviderSettings type="hardcover" settings={{}} onChange={vi.fn()} />);

      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
      expect((screen.getByLabelText('List Type') as HTMLSelectElement).value).toBe('trending');
      expect(screen.queryByLabelText('Shelf ID')).not.toBeInTheDocument();
    });

    it('reveals the Shelf ID input when listType === "shelf"', () => {
      render(
        <ProviderSettings
          type="hardcover"
          settings={{ listType: 'shelf' }}
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByLabelText('Shelf ID')).toBeInTheDocument();
    });

    it('reveals the Shelf ID input after re-rendering with listType === "shelf"', () => {
      const { rerender } = render(
        <ProviderSettings type="hardcover" settings={{}} onChange={vi.fn()} />,
      );
      expect(screen.queryByLabelText('Shelf ID')).not.toBeInTheDocument();

      rerender(
        <ProviderSettings
          type="hardcover"
          settings={{ listType: 'shelf' }}
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByLabelText('Shelf ID')).toBeInTheDocument();
    });

    it('changing List Type via the dropdown calls onChange with the updated value', async () => {
      const spy = vi.fn();
      const user = userEvent.setup();
      render(<StatefulProvider type="hardcover" onChangeSpy={spy} />);

      await user.selectOptions(screen.getByLabelText('List Type'), 'shelf');

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ listType: 'shelf' }));
    });
  });
});
