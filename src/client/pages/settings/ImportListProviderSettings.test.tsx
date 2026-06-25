import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderSettings } from './ImportListProviderSettings';

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

    // #732 — Shelf ID is a numeric input; blank maps to undefined, digits to number
    it('Shelf ID input is type="number" and writes a number to settings on input', async () => {
      const spy = vi.fn();
      const user = userEvent.setup();
      render(
        <StatefulProvider
          type="hardcover"
          initial={{ apiKey: 'k', listType: 'shelf' }}
          onChangeSpy={spy}
        />,
      );

      const input = screen.getByLabelText('Shelf ID') as HTMLInputElement;
      expect(input.type).toBe('number');

      await user.type(input, '42');

      const lastCall = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(lastCall.shelfId).toBe(42);
      expect(typeof lastCall.shelfId).toBe('number');
    });

    it('clearing the Shelf ID input removes shelfId from settings (undefined)', async () => {
      const spy = vi.fn();
      const user = userEvent.setup();
      render(
        <StatefulProvider
          type="hardcover"
          initial={{ apiKey: 'k', listType: 'shelf', shelfId: 42 }}
          onChangeSpy={spy}
        />,
      );

      const input = screen.getByLabelText('Shelf ID') as HTMLInputElement;
      await user.clear(input);

      const lastCall = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect('shelfId' in lastCall).toBe(false);
    });
  });
});
