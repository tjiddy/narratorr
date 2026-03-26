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
  onAdd?: (overrides: { searchImmediately: boolean; monitorForUpgrades: boolean }) => void;
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
  quality: { grabFloor: 0, protocolPreference: 'none' as const, minSeeders: 0, searchImmediately: true, monitorForUpgrades: true, rejectWords: '', requiredWords: '' },
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

  it('opens popover on click with checkboxes and Add to Library button', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      expect(screen.getByText('Search immediately')).toBeInTheDocument();
      expect(screen.getByText('Monitor for upgrades')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add to library/i })).toBeInTheDocument();
    });
  });

  it('syncs checkbox defaults from settings when popover opens', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));

    // Wait for settings query to resolve and sync checkboxes
    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).toBeChecked(); // searchImmediately = true
      expect(checkboxes[1]).toBeChecked(); // monitorForUpgrades = true
    });
  });

  it('calls onAdd with checkbox values when Add to Library is clicked', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPopover({ onAdd });

    await user.click(screen.getByRole('button', { name: /add/i }));

    // Wait for settings to sync defaults
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });

    // Uncheck searchImmediately
    await user.click(screen.getAllByRole('checkbox')[0]);

    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({
        searchImmediately: false,
        monitorForUpgrades: true,
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

  it('toggles monitorForUpgrades independently of searchImmediately', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPopover({ onAdd });

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });

    // Uncheck monitorForUpgrades only (index 1)
    await user.click(screen.getAllByRole('checkbox')[1]);

    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({
        searchImmediately: true,
        monitorForUpgrades: false,
      });
    });
  });

  it('defaults to unchecked when settings fetch fails', async () => {
    vi.mocked(api.getSettings).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));

    // With no settings, checkboxes stay at initial false
    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).not.toBeChecked();
      expect(checkboxes[1]).not.toBeChecked();
    });
  });

  it('syncs defaults when settings resolve after popover is already open', async () => {
    // Simulate slow settings fetch — resolve after popover opens
    let resolveSettings!: (value: typeof defaultSettings) => void;
    vi.mocked(api.getSettings).mockReturnValue(new Promise((res) => { resolveSettings = res; }));

    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPopover({ onAdd });

    // Open popover before settings resolve
    await user.click(screen.getByRole('button', { name: /add/i }));

    // Checkboxes should be unchecked (settings not yet loaded)
    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).not.toBeChecked();
      expect(checkboxes[1]).not.toBeChecked();
    });

    // Now resolve settings
    resolveSettings(defaultSettings);

    // Checkboxes should sync to settings defaults
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
      expect(screen.getAllByRole('checkbox')[1]).toBeChecked();
    });

    // Submit should use synced values
    await user.click(screen.getByRole('button', { name: /add to library/i }));
    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({ searchImmediately: true, monitorForUpgrades: true });
    });
  });

  it('re-syncs defaults each time popover opens', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPopover({ onAdd });

    // Open, uncheck, add
    await user.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });
    await user.click(screen.getAllByRole('checkbox')[0]); // uncheck searchImmediately
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({ searchImmediately: false, monitorForUpgrades: true });
    });

    // Re-open — should reset to defaults
    await user.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked(); // back to true
    });
  });

  describe('portal behavior', () => {

    // Helper to get the trigger button (not "Add to Library")
    function getTriggerButton() {
      return screen.getByRole('button', { name: /^add$/i });
    }

    it('renders popover panel into document.body when opened', async () => {
      const user = userEvent.setup();
      const { container } = renderPopover();

      await user.click(getTriggerButton());

      // Panel should NOT be inside the component's own container
      expect(container.querySelector('[data-popover-portal]')).toBeNull();
      // Panel should be in document.body
      expect(document.body.querySelector('[data-popover-portal]')).not.toBeNull();
      // Content should still be accessible
      expect(screen.getByText('Search immediately')).toBeInTheDocument();
    });

    it('removes popover panel from document.body when closed', async () => {
      const user = userEvent.setup();
      renderPopover();

      await user.click(getTriggerButton());
      expect(document.body.querySelector('[data-popover-portal]')).not.toBeNull();

      // Close by clicking Add to Library
      await user.click(screen.getByRole('button', { name: /add to library/i }));
      expect(document.body.querySelector('[data-popover-portal]')).toBeNull();
    });

    it('does not close popover when clicking inside the portaled panel', async () => {
      const user = userEvent.setup();
      renderPopover();

      await user.click(getTriggerButton());

      // Wait for settings to load
      await waitFor(() => {
        expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
      });

      // Click a checkbox inside the portaled panel
      await user.click(screen.getAllByRole('checkbox')[0]);

      // Popover should still be open
      expect(screen.getByText('Search immediately')).toBeInTheDocument();
      expect(screen.getByText('Monitor for upgrades')).toBeInTheDocument();
    });

    it('closes popover when clicking outside both trigger and panel', async () => {
      const user = userEvent.setup();
      renderPopover();

      await user.click(getTriggerButton());
      expect(screen.getByText('Search immediately')).toBeInTheDocument();

      // Click on document.body (outside both trigger and panel)
      await user.click(document.body);

      expect(screen.queryByText('Search immediately')).not.toBeInTheDocument();
    });

    it('closes popover when clicking the trigger button while open', async () => {
      const user = userEvent.setup();
      renderPopover();

      // Open
      await user.click(getTriggerButton());
      expect(screen.getByText('Search immediately')).toBeInTheDocument();

      // Click trigger again to close
      await user.click(getTriggerButton());
      expect(screen.queryByText('Search immediately')).not.toBeInTheDocument();
    });

    it('positions popover right-aligned below trigger on open', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      // Mock a known trigger rect (unclamped — trigger.right > PANEL_WIDTH)
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 140, left: 300, right: 400, width: 100, height: 40, x: 300, y: 100, toJSON: () => ({}),
      });

      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      // top = bottom + 8 (mt-2 gap)
      expect(portal.style.top).toBe('148px');
      // left = right - PANEL_WIDTH (right-aligned)
      expect(portal.style.left).toBe('144px'); // 400 - 256
    });

    it('repositions popover to exact coordinates on scroll', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      // Mock getBoundingClientRect to return new position after scroll
      // right=500 > PANEL_WIDTH=256, so no clamping needed
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 200, bottom: 240, left: 400, right: 500, width: 100, height: 40, x: 400, y: 200, toJSON: () => ({}),
      });

      window.dispatchEvent(new Event('scroll'));

      await waitFor(() => {
        // top = bottom + 8
        expect(portal.style.top).toBe('248px');
        // left = right - PANEL_WIDTH (right-aligned)
        expect(portal.style.left).toBe('244px'); // 500 - 256
      });
    });

    it('repositions popover to exact coordinates on resize', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      // Mock getBoundingClientRect to return new position after resize
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 300, bottom: 340, left: 500, right: 600, width: 100, height: 40, x: 500, y: 300, toJSON: () => ({}),
      });

      window.dispatchEvent(new Event('resize'));

      await waitFor(() => {
        // top = bottom + 8
        expect(portal.style.top).toBe('348px');
        // left = right - PANEL_WIDTH (right-aligned)
        expect(portal.style.left).toBe('344px'); // 600 - 256
      });
    });

    it('clamps popover to viewport bounds when trigger is near right edge', async () => {
      const user = userEvent.setup();
      renderPopover();

      const trigger = getTriggerButton();
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 140, left: 700, right: 800, width: 100, height: 40, x: 700, y: 100, toJSON: () => ({}),
      });
      // Set viewport width narrow — maxLeft = 400 - 256 = 144
      Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });

      await user.click(trigger);
      const portal = document.body.querySelector('[data-popover-portal]') as HTMLElement;
      expect(portal).not.toBeNull();

      // top = bottom + 8
      expect(portal.style.top).toBe('148px');
      // left = Math.max(0, Math.min(800 - 256, 400 - 256)) = Math.max(0, Math.min(544, 144)) = 144
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
