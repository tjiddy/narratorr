import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { DownloadClientFields } from './DownloadClientFields';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';

vi.mock('@/lib/api/download-clients', () => ({
  downloadClientsApi: {
    getClientCategories: vi.fn(),
    getClientCategoriesFromConfig: vi.fn(),
  },
}));

import { downloadClientsApi } from '@/lib/api/download-clients';

function FieldWrapper({ type, clientId, dirty, isEdit }: { type: string; clientId?: number; dirty?: boolean; isEdit?: boolean }) {
  const { register, formState: { errors }, setValue, getValues } = useForm<CreateDownloadClientFormData>({
    defaultValues: { name: 'Test', type: 'qbittorrent', enabled: true, priority: 50, settings: { host: '', port: 8080 } },
  });
  return (
    <DownloadClientFields
      selectedType={type}
      register={register}
      errors={errors}
      clientId={clientId}
      setValue={setValue}
      getValues={getValues}
      isDirty={dirty}
      isEdit={isEdit}
    />
  );
}

describe('DownloadClientFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders qbittorrent fields and accepts host input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('SSL')).toBeInTheDocument();
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();

    const host = screen.getByPlaceholderText('localhost');
    await user.type(host, '10.0.0.1');
    expect(host).toHaveValue('10.0.0.1');
  });

  it('renders transmission fields and accepts username input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="transmission" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('SSL')).toBeInTheDocument();

    const username = screen.getByPlaceholderText('admin');
    await user.type(username, 'user1');
    expect(username).toHaveValue('user1');
  });

  it('renders sabnzbd fields with API Key and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="sabnzbd" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
    expect(screen.getByText('SSL')).toBeInTheDocument();
    expect(screen.queryByText('Username')).not.toBeInTheDocument();
    expect(screen.queryByText('Password')).not.toBeInTheDocument();

    const apiKey = screen.getByText('API Key').closest('div')!.querySelector('input')!;
    await user.type(apiKey, 'abc123');
    expect(apiKey).toHaveValue('abc123');
  });

  it('renders deluge fields with password but no username', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="deluge" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('SSL')).toBeInTheDocument();
    expect(screen.queryByText('Username')).not.toBeInTheDocument();

    const password = screen.getByLabelText('Password');
    await user.type(password, 'deluge');
    expect(password).toHaveValue('deluge');
  });

  it('shows fetch button for deluge (supports categories)', () => {
    render(<FieldWrapper type="deluge" />);
    expect(screen.getByRole('button', { name: /fetch/i })).toBeInTheDocument();
  });

  it('defaults to qbittorrent fields for unknown type and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="unknown" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();

    const host = screen.getByPlaceholderText('localhost');
    await user.type(host, 'fallback.local');
    expect(host).toHaveValue('fallback.local');
  });

  it('allows typing in host field', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    const input = screen.getByPlaceholderText('localhost');
    await user.type(input, '192.168.1.10');
    expect(input).toHaveValue('192.168.1.10');
  });

  it('renders category field for all client types', () => {
    render(<FieldWrapper type="qbittorrent" />);
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('audiobooks')).toBeInTheDocument();
  });

  it('allows typing in category field', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    const input = screen.getByPlaceholderText('audiobooks');
    await user.type(input, 'my-audiobooks');
    expect(input).toHaveValue('my-audiobooks');
  });

  it('shows category field for sabnzbd', () => {
    render(<FieldWrapper type="sabnzbd" />);
    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('allows toggling SSL checkbox', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    const checkbox = screen.getByRole('checkbox', { name: /SSL/i });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  describe('layout grouping', () => {
    it('renders SSL checkbox in the same container as Host and Port fields', () => {
      render(<FieldWrapper type="qbittorrent" />);
      const connectionRow = screen.getByTestId('connection-row');
      expect(connectionRow.querySelector('#clientHost')).toBeInTheDocument();
      expect(connectionRow.querySelector('#clientPort')).toBeInTheDocument();
      expect(connectionRow.querySelector('input[type="checkbox"]')).toBeInTheDocument();
    });

    it('renders API Key with full-width span', () => {
      render(<FieldWrapper type="sabnzbd" />);
      const apiKeyContainer = screen.getByTestId('api-key-field');
      expect(apiKeyContainer).toHaveClass('sm:col-span-2');
    });

    it('renders Enabled, Priority, and Category in the same behavior row in edit mode', () => {
      render(<FieldWrapper type="qbittorrent" isEdit />);
      const behaviorRow = screen.getByTestId('behavior-row');
      expect(behaviorRow.querySelector('#clientPriority')).toBeInTheDocument();
      expect(behaviorRow.querySelector('#clientCategory')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /Enabled/i })).toBeInTheDocument();
    });

    it('renders only Category in behavior row when not in edit mode', () => {
      render(<FieldWrapper type="qbittorrent" />);
      const behaviorRow = screen.getByTestId('behavior-row');
      expect(behaviorRow.querySelector('#clientCategory')).toBeInTheDocument();
      expect(behaviorRow.querySelector('#clientPriority')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: /Enabled/i })).not.toBeInTheDocument();
    });
  });

  describe('fetch categories button', () => {
    it('shows fetch button for qbittorrent', () => {
      render(<FieldWrapper type="qbittorrent" />);
      expect(screen.getByRole('button', { name: /fetch/i })).toBeInTheDocument();
    });

    it('shows fetch button for sabnzbd', () => {
      render(<FieldWrapper type="sabnzbd" />);
      expect(screen.getByRole('button', { name: /fetch/i })).toBeInTheDocument();
    });

    it('shows fetch button for nzbget', () => {
      render(<FieldWrapper type="nzbget" />);
      expect(screen.getByRole('button', { name: /fetch/i })).toBeInTheDocument();
    });

    it('hides fetch button for transmission', () => {
      render(<FieldWrapper type="transmission" />);
      expect(screen.queryByRole('button', { name: /fetch/i })).not.toBeInTheDocument();
    });

    it('uses by-id route when clientId is set and form is clean', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategories as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: ['audiobooks'] });

      render(<FieldWrapper type="qbittorrent" clientId={1} dirty={false} />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        expect(downloadClientsApi.getClientCategories).toHaveBeenCalledWith(1);
      });
    });

    it('uses by-config route when form is dirty', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: ['audiobooks'] });

      render(<FieldWrapper type="qbittorrent" clientId={1} dirty={true} />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        const payload = (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
        // Verify exact top-level keys — no extra fields leak into the payload
        expect(Object.keys(payload).sort()).toEqual(['enabled', 'name', 'priority', 'settings', 'type']);
        expect(payload.name).toBe('Test');
        expect(payload.type).toBe('qbittorrent');
        expect(payload.enabled).toBe(true);
        expect(payload.priority).toBe(50);
        expect(payload.settings).toMatchObject({ host: '', port: 8080 });
      });
    });

    it('uses by-config route in create mode (no clientId)', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: ['audiobooks'] });

      render(<FieldWrapper type="qbittorrent" />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        const payload = (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
        // Verify exact top-level keys — no extra fields leak into the payload
        expect(Object.keys(payload).sort()).toEqual(['enabled', 'name', 'priority', 'settings', 'type']);
        expect(payload.name).toBe('Test');
        expect(payload.type).toBe('qbittorrent');
        expect(payload.enabled).toBe(true);
        expect(payload.priority).toBe(50);
        expect(payload.settings).toMatchObject({ host: '', port: 8080 });
      });
    });

    it('shows category dropdown after successful fetch', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: ['audiobooks', 'movies'],
      });

      render(<FieldWrapper type="qbittorrent" />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        expect(screen.getByText('audiobooks')).toBeInTheDocument();
        expect(screen.getByText('movies')).toBeInTheDocument();
      });
    });

    it('populates category input when selecting from dropdown', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: ['audiobooks', 'movies'],
      });

      render(<FieldWrapper type="qbittorrent" />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        expect(screen.getByText('audiobooks')).toBeInTheDocument();
      });

      await user.click(screen.getByText('audiobooks'));

      expect(screen.getByPlaceholderText('audiobooks')).toHaveValue('audiobooks');
    });

    it('shows inline error on fetch failure', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: [],
        error: 'Connection refused',
      });

      render(<FieldWrapper type="qbittorrent" />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        expect(screen.getByText('Connection refused')).toBeInTheDocument();
      });
    });

    it('clears error on successful fetch after previous error', async () => {
      const user = userEvent.setup();
      const mockFn = downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>;
      mockFn.mockResolvedValueOnce({ categories: [], error: 'Connection refused' });
      mockFn.mockResolvedValueOnce({ categories: ['audiobooks'] });

      render(<FieldWrapper type="qbittorrent" />);

      // First fetch fails
      await user.click(screen.getByRole('button', { name: /fetch/i }));
      await waitFor(() => {
        expect(screen.getByText('Connection refused')).toBeInTheDocument();
      });

      // Second fetch succeeds
      await user.click(screen.getByRole('button', { name: /fetch/i }));
      await waitFor(() => {
        expect(screen.queryByText('Connection refused')).not.toBeInTheDocument();
        expect(screen.getByText('audiobooks')).toBeInTheDocument();
      });
    });

    it('shows "No categories found" when fetch returns empty array', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: [],
      });

      render(<FieldWrapper type="qbittorrent" />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        expect(screen.getByText('No categories found')).toBeInTheDocument();
      });
    });

    it('shows inline error when API call throws', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      render(<FieldWrapper type="qbittorrent" />);

      await user.click(screen.getByRole('button', { name: /fetch/i }));

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('shows fallback message and hides dropdown when API rejects a non-Error value', async () => {
      const user = userEvent.setup();
      const mockFn = downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>;
      // First fetch succeeds and opens the dropdown
      mockFn.mockResolvedValueOnce({ categories: [] });
      // Second fetch rejects with a non-Error value
      mockFn.mockRejectedValueOnce('string-rejection');

      render(<FieldWrapper type="qbittorrent" />);

      // Open the dropdown with a successful fetch
      await user.click(screen.getByRole('button', { name: /fetch/i }));
      await waitFor(() => {
        expect(screen.getByText('No categories found')).toBeInTheDocument();
      });

      // Trigger the non-Error rejection
      await user.click(screen.getByRole('button', { name: /fetch/i }));
      await waitFor(() => {
        expect(screen.getByText('Failed to fetch categories')).toBeInTheDocument();
      });
      expect(screen.queryByText('No categories found')).not.toBeInTheDocument();
    });
  });

  describe('z-index scale (CSS-1)', () => {
    it('autocomplete dropdown renders via portal with z-30 class (dropdown scale)', async () => {
      const user = userEvent.setup();
      (downloadClientsApi.getClientCategoriesFromConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        categories: ['cat1'],
      });
      render(<FieldWrapper type="qbittorrent" />);
      await user.click(screen.getByRole('button', { name: /fetch/i }));
      await waitFor(() => {
        expect(screen.getByText('cat1')).toBeInTheDocument();
      });
      // ToolbarDropdown renders a fixed z-30 portal container to document.body
      const portalContainer = screen.getByText('cat1').closest('div.fixed');
      expect(portalContainer).toHaveClass('z-30');
    });
  });
});
