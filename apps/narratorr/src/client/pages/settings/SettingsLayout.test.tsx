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
    expect(screen.getByText('Indexers').closest('a')).toHaveAttribute('href', '/settings/indexers');
    expect(screen.getByText('Download Clients').closest('a')).toHaveAttribute('href', '/settings/download-clients');
    expect(screen.getByText('Notifications').closest('a')).toHaveAttribute('href', '/settings/notifications');
    expect(screen.getByText('Blacklist').closest('a')).toHaveAttribute('href', '/settings/blacklist');

    // Navigate to Indexers
    await user.click(screen.getByText('Indexers'));
    expect(screen.getByText('Indexers').closest('a')).toHaveAttribute('href', '/settings/indexers');
  });

  it('navigates between settings sections', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsLayout />, { route: '/settings' });

    await user.click(screen.getByText('Download Clients'));
    expect(screen.getByText('Download Clients').closest('a')).toHaveAttribute('href', '/settings/download-clients');

    await user.click(screen.getByText('Notifications'));
    expect(screen.getByText('Notifications').closest('a')).toHaveAttribute('href', '/settings/notifications');
  });
});
