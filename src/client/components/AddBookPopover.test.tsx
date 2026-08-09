import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddBookPopover } from './AddBookPopover';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { createMockSettings } from '@/__tests__/factories';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderPopover({
  onAdd = vi.fn(),
  isPending = false,
}: {
  onAdd?: (overrides: { searchImmediately: boolean }) => void;
  isPending?: boolean;
} = {}) {
  const queryClient = createQueryClient();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AddBookPopover onAdd={onAdd} isPending={isPending} />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const defaultSettings = createMockSettings({
  quality: { grabFloor: 0, protocolPreference: 'none' as const, minSeeders: 0, searchImmediately: true, rejectWords: '', requiredWords: '' },
});

describe('AddBookPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings);
  });

  it('renders Add button', () => {
    renderPopover();
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('opens popover on click with checkbox and Add to Library button', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      expect(screen.getByText('Search immediately')).toBeInTheDocument();
      expect(screen.queryByText('Monitor for upgrades')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add to library/i })).toBeInTheDocument();
    });
  });

  it('syncs checkbox defaults from settings when popover opens', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes).toHaveLength(1);
    });
  });

  it('calls onAdd with checkbox value when Add to Library is clicked', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPopover({ onAdd });

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });

    await user.click(screen.getAllByRole('checkbox')[0]!);

    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({
        searchImmediately: false,
      });
    });
  });

  it('closes popover after Add to Library is clicked', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(screen.getByText('Search immediately')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(screen.queryByText('Search immediately')).not.toBeInTheDocument();
    });
  });

  it('shows Adding... text when isPending is true', () => {
    renderPopover({ isPending: true });
    expect(screen.getByText('Adding...')).toBeInTheDocument();
  });

  it('disables button when isPending is true', () => {
    renderPopover({ isPending: true });
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('defaults to unchecked when settings fetch fails', async () => {
    vi.mocked(api.getSettings).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).not.toBeChecked();
    });
  });

  it('syncs defaults when settings resolve after popover is already open', async () => {
    let resolveSettings!: (value: typeof defaultSettings) => void;
    vi.mocked(api.getSettings).mockReturnValue(new Promise((res) => { resolveSettings = res; }));

    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPopover({ onAdd });

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).not.toBeChecked();
    });

    resolveSettings(defaultSettings);

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });

    await user.click(screen.getByRole('button', { name: /add to library/i }));
    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({ searchImmediately: true });
    });
  });

  it('re-syncs defaults each time popover opens', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPopover({ onAdd });

    await user.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });
    await user.click(screen.getAllByRole('checkbox')[0]!);
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({ searchImmediately: false });
    });

    await user.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });
  });

  describe('portal behavior', () => {

    function getTriggerButton() {
      return screen.getByRole('button', { name: /^add book$/i });
    }

    it('renders popover panel into document.body when opened', async () => {
      const user = userEvent.setup();
      const { container } = renderPopover();

      await user.click(getTriggerButton());

      expect(container.querySelector('[data-popover-portal]')).toBeNull();
      expect(document.body.querySelector('[data-popover-portal]')).not.toBeNull();
      expect(screen.getByText('Search immediately')).toBeInTheDocument();
    });

    it('removes popover panel from document.body when closed', async () => {
      const user = userEvent.setup();
      renderPopover();

      await user.click(getTriggerButton());
      expect(document.body.querySelector('[data-popover-portal]')).not.toBeNull();

      await user.click(screen.getByRole('button', { name: /add to library/i }));
      expect(document.body.querySelector('[data-popover-portal]')).toBeNull();
    });

    it('does not close popover when clicking inside the portaled panel', async () => {
      const user = userEvent.setup();
      renderPopover();

      await user.click(getTriggerButton());

      await waitFor(() => {
        expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
      });

      await user.click(screen.getAllByRole('checkbox')[0]!);

      expect(screen.getByText('Search immediately')).toBeInTheDocument();
    });

    it('closes popover when clicking outside both trigger and panel', async () => {
      const user = userEvent.setup();
      renderPopover();

      await user.click(getTriggerButton());
      expect(screen.getByText('Search immediately')).toBeInTheDocument();

      await user.click(document.body);

      expect(screen.queryByText('Search immediately')).not.toBeInTheDocument();
    });

    it('closes popover when clicking the trigger button while open', async () => {
      const user = userEvent.setup();
      renderPopover();

      await user.click(getTriggerButton());
      expect(screen.getByText('Search immediately')).toBeInTheDocument();

      await user.click(getTriggerButton());
      expect(screen.queryByText('Search immediately')).not.toBeInTheDocument();
    });

    it('positions popover right-aligned below trigger on open', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 140, left: 300, right: 400, width: 100, height: 40, x: 300, y: 100, toJSON: () => ({}),
      });

      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      expect(portal.style.top).toBe('148px');
      expect(portal.style.left).toBe('144px');
    });

    it('repositions popover to exact coordinates on scroll', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 200, bottom: 240, left: 400, right: 500, width: 100, height: 40, x: 400, y: 200, toJSON: () => ({}),
      });

      window.dispatchEvent(new Event('scroll'));

      await waitFor(() => {
        expect(portal.style.top).toBe('248px');
        expect(portal.style.left).toBe('244px');
      });
    });

    it('repositions popover to exact coordinates on resize', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 300, bottom: 340, left: 500, right: 600, width: 100, height: 40, x: 500, y: 300, toJSON: () => ({}),
      });

      window.dispatchEvent(new Event('resize'));

      await waitFor(() => {
        expect(portal.style.top).toBe('348px');
        expect(portal.style.left).toBe('344px');
      });
    });

    it('clamps popover to viewport bounds when trigger is near right edge', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 140, left: 700, right: 800, width: 100, height: 40, x: 700, y: 100, toJSON: () => ({}),
      });
      Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });

      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      expect(portal.style.top).toBe('148px');
      expect(portal.style.left).toBe('144px');
    });

    it('cleans up portal on unmount', async () => {
      const user = userEvent.setup();
      const { unmount } = renderPopover();

      await user.click(getTriggerButton());
      expect(document.body.querySelector('[data-popover-portal]')).not.toBeNull();

      unmount();
      expect(document.body.querySelector('[data-popover-portal]')).toBeNull();
    });
  });

  describe('z-index scale', () => {
    it('portal container has z-40 class (popover scale)', async () => {
      const user = userEvent.setup();
      renderPopover();
      await user.click(screen.getByRole('button', { name: /add/i }));
      await waitFor(() => {
        const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
        expect(portal).not.toBeNull();
        expect(portal).toHaveClass('z-40');
      });
    });
  });
});
