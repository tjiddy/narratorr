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
  quality: { grabFloor: 0, protocolPreference: 'none' as const, minSeeders: 0, searchImmediately: true, monitorForUpgrades: true },
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

    expect(screen.getByText('Search immediately')).toBeInTheDocument();
    expect(screen.getByText('Monitor for upgrades')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to library/i })).toBeInTheDocument();
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

    expect(onAdd).toHaveBeenCalledWith({
      searchImmediately: false,
      monitorForUpgrades: true,
    });
  });

  it('closes popover after Add to Library is clicked', async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getByText('Search immediately')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(screen.queryByText('Search immediately')).not.toBeInTheDocument();
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

    expect(onAdd).toHaveBeenCalledWith({
      searchImmediately: true,
      monitorForUpgrades: false,
    });
  });

  it('defaults to unchecked when settings fetch fails', async () => {
    vi.mocked(api.getSettings).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByRole('button', { name: /add/i }));

    // With no settings, checkboxes stay at initial false
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
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
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();

    // Now resolve settings
    resolveSettings(defaultSettings);

    // Checkboxes should sync to settings defaults
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
      expect(screen.getAllByRole('checkbox')[1]).toBeChecked();
    });

    // Submit should use synced values
    await user.click(screen.getByRole('button', { name: /add to library/i }));
    expect(onAdd).toHaveBeenCalledWith({ searchImmediately: true, monitorForUpgrades: true });
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

    expect(onAdd).toHaveBeenCalledWith({ searchImmediately: false, monitorForUpgrades: true });

    // Re-open — should reset to defaults
    await user.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked(); // back to true
    });
  });
});
