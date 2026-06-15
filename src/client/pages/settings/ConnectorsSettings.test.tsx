import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockConnector } from '@/__tests__/factories';
import { waitForListLoad } from '@/__tests__/crud-settings-helpers';
import { ConnectorsSettings } from './ConnectorsSettings';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', async (importOriginal) => ({
  // Preserve real non-api exports (ApiError etc.) that useCrudSettings references.
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    getConnectors: vi.fn(),
    createConnector: vi.fn(),
    updateConnector: vi.fn(),
    deleteConnector: vi.fn(),
    testConnector: vi.fn(),
    testConnectorConfig: vi.fn(),
    fetchConnectorTargets: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { api } from '@/lib/api';

// An existing Plex connector — token/baseUrl arrive masked from the API (#1492).
const plexConnector = createMockConnector({
  id: 7,
  name: 'My Plex',
  type: 'plex',
  settings: { baseUrl: '********', token: '********', sectionId: '1', pathMappings: [], fallbackToFullRefresh: false },
});

beforeEach(() => {
  vi.clearAllMocks();
  (api.getConnectors as Mock).mockResolvedValue([plexConnector]);
});

function modalContainer(): HTMLElement {
  const backdrop = screen.getByTestId('modal-backdrop');
  return backdrop.closest('.fixed.inset-0') as HTMLElement;
}

describe('ConnectorsSettings — #1492 edit-mode id injection (shared useCrudSettings/useConnectionTest)', () => {
  it('edit-mode Test posts the editing connector id to testConnectorConfig for Plex (so the masked token sentinel can resolve server-side)', async () => {
    const user = userEvent.setup();
    (api.testConnectorConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });
    renderWithProviders(<ConnectorsSettings />);
    await waitForListLoad('My Plex');

    await user.click(screen.getByLabelText('Edit My Plex'));
    await waitFor(() => expect(screen.getByText('Edit Connector')).toBeInTheDocument());

    // Form-test button inside the modal (not the in-list view-mode Test).
    await user.click(within(modalContainer()).getByRole('button', { name: /^test$/i }));

    await waitFor(() => expect(api.testConnectorConfig).toHaveBeenCalled());
    const payload = (api.testConnectorConfig as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({ id: 7, type: 'plex' });
    // The injected id is what lets the server resolve the masked token sentinel.
    expect(payload.settings).toMatchObject({ token: '********', sectionId: '1' });
  });

  it('create-mode Test posts no id key to testConnectorConfig (centralized injection opts out for create)', async () => {
    const user = userEvent.setup();
    (api.testConnectorConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });
    renderWithProviders(<ConnectorsSettings />);
    await waitForListLoad('My Plex');

    await user.click(screen.getByRole('button', { name: 'Add Connector' }));
    // Default type is Audiobookshelf — fill its required fields, then Test.
    await user.type(screen.getByPlaceholderText('My Audiobookshelf'), 'Brand New');
    await user.type(screen.getByPlaceholderText('http://audiobookshelf.local:13378'), 'http://abs.local');
    await user.type(screen.getByPlaceholderText('API key is required'), 'k');
    await user.type(screen.getByPlaceholderText('Library ID (or fetch)'), 'lib-1');

    await user.click(within(modalContainer()).getByRole('button', { name: /^test$/i }));

    await waitFor(() => expect(api.testConnectorConfig).toHaveBeenCalled());
    const payload = (api.testConnectorConfig as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('id');
  });
});
