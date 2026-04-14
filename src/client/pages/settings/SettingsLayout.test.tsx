import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { SettingsLayout } from './SettingsLayout';

function SettingsApp() {
  return (
    <Routes>
      <Route path="/settings/*" element={<SettingsLayout />} />
    </Routes>
  );
}

vi.mock('./GeneralSettings.js', () => ({
  GeneralSettings: () => <div data-testid="general-settings">General Settings Content</div>,
}));
vi.mock('./SystemSettings.js', () => ({
  SystemSettings: () => <div data-testid="system-settings">System Settings Content</div>,
}));
vi.mock('./IndexersSettings.js', () => ({
  IndexersSettings: () => <div data-testid="indexers-settings">Indexers Settings Content</div>,
}));
vi.mock('./PostProcessingSettings.js', () => ({
  PostProcessingSettings: () => <div>Post Processing Content</div>,
}));
vi.mock('./DownloadClientsSettings.js', () => ({
  DownloadClientsSettings: () => <div>Download Clients Content</div>,
}));
vi.mock('./SearchSettingsPage.js', () => ({
  SearchSettingsPage: () => <div>Search Settings Content</div>,
}));
vi.mock('./NotificationsSettings.js', () => ({
  NotificationsSettings: () => <div>Notifications Content</div>,
}));
vi.mock('./BlacklistSettings.js', () => ({
  BlacklistSettings: () => <div>Blacklist Content</div>,
}));
vi.mock('./SecuritySettings.js', () => ({
  SecuritySettings: () => <div>Security Content</div>,
}));
vi.mock('./ImportListsSettings.js', () => ({
  ImportListsSettings: () => <div>Import Lists Content</div>,
}));

describe('SettingsLayout', () => {
  it('renders all nav items with correct link targets', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsApp />, { route: '/settings' });

    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('General').closest('a')).toHaveAttribute('href', '/settings');
    expect(screen.getByText('Post Processing').closest('a')).toHaveAttribute('href', '/settings/post-processing');
    expect(screen.getByText('Indexers').closest('a')).toHaveAttribute('href', '/settings/indexers');
    expect(screen.getByText('Download Clients').closest('a')).toHaveAttribute('href', '/settings/download-clients');
    expect(screen.getByText('Search').closest('a')).toHaveAttribute('href', '/settings/search');
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
    renderWithProviders(<SettingsApp />, { route: '/settings' });

    const generalLink = screen.getByText('General').closest('a')!;
    const systemLink = screen.getByText('System').closest('a')!;

    expect(generalLink.className).toContain('bg-primary');
    expect(systemLink.className).not.toContain('bg-primary');
  });

  it('applies active styling to System when at /settings/system', () => {
    renderWithProviders(<SettingsApp />, { route: '/settings/system' });

    const generalLink = screen.getByText('General').closest('a')!;
    const systemLink = screen.getByText('System').closest('a')!;

    expect(generalLink.className).not.toContain('bg-primary');
    expect(systemLink.className).toContain('bg-primary');
  });

  it('applies active styling to Post Processing when at /settings/post-processing', () => {
    renderWithProviders(<SettingsApp />, { route: '/settings/post-processing' });

    const generalLink = screen.getByText('General').closest('a')!;
    const postProcessingLink = screen.getByText('Post Processing').closest('a')!;

    expect(generalLink.className).not.toContain('bg-primary');
    expect(postProcessingLink.className).toContain('bg-primary');
  });

  it('navigates between settings sections', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsApp />, { route: '/settings' });

    await user.click(screen.getByText('Download Clients'));
    expect(screen.getByText('Download Clients').closest('a')).toHaveAttribute('href', '/settings/download-clients');

    await user.click(screen.getByText('Notifications'));
    expect(screen.getByText('Notifications').closest('a')).toHaveAttribute('href', '/settings/notifications');
  });

  it('renders General settings content at /settings (index route)', () => {
    renderWithProviders(<SettingsApp />, { route: '/settings' });

    expect(screen.getByTestId('general-settings')).toBeInTheDocument();
  });

  it('renders System settings content at /settings/system', () => {
    renderWithProviders(<SettingsApp />, { route: '/settings/system' });

    expect(screen.getByTestId('system-settings')).toBeInTheDocument();
  });

  it('renders Indexers settings content at /settings/indexers', () => {
    renderWithProviders(<SettingsApp />, { route: '/settings/indexers' });

    expect(screen.getByTestId('indexers-settings')).toBeInTheDocument();
  });
});
