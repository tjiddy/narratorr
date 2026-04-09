import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BookHero } from './BookHero';

const defaultProps = {
  title: 'Test Book',
  authorName: 'Test Author',
  coverUrl: 'https://example.com/cover.jpg',
  metaDots: ['10h 0m', 'Fantasy'],
  statusLabel: 'Imported',
  statusDotClass: 'bg-green-500',
  hasPath: true,
  onBackClick: vi.fn(),
  onSearchClick: vi.fn(),
  onEditClick: vi.fn(),
  onRenameClick: vi.fn(),
  isRenaming: false,
  onRetagClick: vi.fn(),
  isRetagging: false,
  retagDisabled: false,
  monitorForUpgrades: false,
  onMonitorToggle: vi.fn(),
  isMonitorToggling: false,
  onMergeClick: vi.fn(),
  isMerging: false,
  canMerge: false,
  mergeDisabled: false,
  onRemoveClick: vi.fn(),
  isRemoving: false,
};

function renderHero(overrides = {}) {
  return render(
    <MemoryRouter>
      <BookHero {...defaultProps} {...overrides} />
    </MemoryRouter>,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('More actions'));
}

describe('BookHero — Refresh & Scan menu item', () => {
  it('shows "Refresh & Scan" menu item when showRefreshScan is true', async () => {
    const user = userEvent.setup();
    const onRefreshScanClick = vi.fn();
    renderHero({ showRefreshScan: true, onRefreshScanClick });
    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Refresh & Scan' })).toBeInTheDocument();
  });

  it('hides "Refresh & Scan" when showRefreshScan is false', async () => {
    const user = userEvent.setup();
    renderHero({ showRefreshScan: false });
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: 'Refresh & Scan' })).not.toBeInTheDocument();
  });

  it('hides "Refresh & Scan" when showRefreshScan is undefined', async () => {
    const user = userEvent.setup();
    renderHero();
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: 'Refresh & Scan' })).not.toBeInTheDocument();
  });

  it('shows loading spinner during scan', async () => {
    const user = userEvent.setup();
    const onRefreshScanClick = vi.fn();
    renderHero({ showRefreshScan: true, onRefreshScanClick, isRefreshingScanning: true });
    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Scanning...' })).toBeInTheDocument();
  });

  it('disables menu item while scanning', async () => {
    const user = userEvent.setup();
    const onRefreshScanClick = vi.fn();
    renderHero({ showRefreshScan: true, onRefreshScanClick, isRefreshingScanning: true });
    await openMenu(user);
    const item = screen.getByRole('menuitem', { name: 'Scanning...' });
    expect(item).toBeDisabled();
  });

  it('calls onRefreshScanClick when menu item is clicked', async () => {
    const user = userEvent.setup();
    const onRefreshScanClick = vi.fn();
    renderHero({ showRefreshScan: true, onRefreshScanClick });
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Refresh & Scan' }));
    expect(onRefreshScanClick).toHaveBeenCalledTimes(1);
  });

  it('menu item positioned between Re-tag and Merge to M4B', async () => {
    const user = userEvent.setup();
    const onRefreshScanClick = vi.fn();
    renderHero({ showRefreshScan: true, onRefreshScanClick, canMerge: true });
    await openMenu(user);

    const menuItems = screen.getAllByRole('menuitem');
    const names = menuItems.map(el => el.textContent?.trim());
    const retagIdx = names.indexOf('Re-tag files');
    const refreshIdx = names.indexOf('Refresh & Scan');
    const mergeIdx = names.indexOf('Merge to M4B');

    expect(retagIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(retagIdx);
    expect(refreshIdx).toBeLessThan(mergeIdx);
  });
});
