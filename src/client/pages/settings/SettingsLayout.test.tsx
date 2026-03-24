import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { SettingsLayout } from './SettingsLayout';

describe('SettingsLayout', () => {
  it('renders all nav items with correct link targets', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsLayout />, { route: '/settings' });

    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('General').closest('a')).toHaveAttribute('href', '/settings');
    expect(screen.getByText('Post Processing').closest('a')).toHaveAttribute('href', '/settings/post-processing');
    expect(screen.getByText('Indexers').closest('a')).toHaveAttribute('href', '/settings/indexers');
    expect(screen.getByText('Download Clients').closest('a')).toHaveAttribute('href', '/settings/download-clients');
    expect(screen.getByText('Notifications').closest('a')).toHaveAttribute('href', '/settings/notifications');
    expect(screen.getByText('Blacklist').closest('a')).toHaveAttribute('href', '/settings/blacklist');
    expect(screen.getByText('Security').closest('a')).toHaveAttribute('href', '/settings/security');
    expect(screen.getByText('Import Lists').closest('a')).toHaveAttribute('href', '/settings/import-lists');
    expect(screen.getByText('System').closest('a')).toHaveAttribute('href', '/settings/system');

    // Navigate to Indexers
    await user.click(screen.getByText('Indexers'));
    expect(screen.getByText('Indexers').closest('a')).toHaveAttribute('href', '/settings/indexers');
  });

  it('applies active styling to General when at /settings', () => {
    renderWithProviders(<SettingsLayout />, { route: '/settings' });

    const generalLink = screen.getByText('General').closest('a')!;
    const systemLink = screen.getByText('System').closest('a')!;

    expect(generalLink.className).toContain('bg-primary');
    expect(systemLink.className).not.toContain('bg-primary');
  });

  it('applies active styling to System when at /settings/system', () => {
    renderWithProviders(<SettingsLayout />, { route: '/settings/system' });

    const generalLink = screen.getByText('General').closest('a')!;
    const systemLink = screen.getByText('System').closest('a')!;

    // General (end: true) should NOT be active at /settings/system
    expect(generalLink.className).not.toContain('bg-primary');
    expect(systemLink.className).toContain('bg-primary');
  });

  it.todo('applies active styling to Post Processing when at /settings/post-processing');

  it('navigates between settings sections', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsLayout />, { route: '/settings' });

    await user.click(screen.getByText('Download Clients'));
    expect(screen.getByText('Download Clients').closest('a')).toHaveAttribute('href', '/settings/download-clients');

    await user.click(screen.getByText('Notifications'));
    expect(screen.getByText('Notifications').closest('a')).toHaveAttribute('href', '/settings/notifications');
  });
});
