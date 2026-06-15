import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect, useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockConnector } from '@/__tests__/factories';
import { ConnectorCard } from './ConnectorCard';
import type { Connector, TestResult } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    ...(await importOriginal<typeof import('@/lib/api')>()).api,
    fetchConnectorTargets: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mockConnector: Connector = createMockConnector({ id: 1, name: 'My ABS' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectorCard — view mode', () => {
  it('displays name and type subtitle (masked baseUrl degrades to the type fallback, never leaks the sentinel)', () => {
    renderWithProviders(<ConnectorCard connector={mockConnector} mode="view" onSubmit={vi.fn()} onFormTest={vi.fn()} />);
    expect(screen.getByText('My ABS')).toBeInTheDocument();
    // baseUrl is a masked secret from the API; extractHostname can't parse '********'
    // so the subtitle degrades to the type label fallback rather than leaking the sentinel.
    expect(screen.getByText(/Audiobookshelf — Audiobookshelf/)).toBeInTheDocument();
    expect(screen.queryByText(/\*{8}/)).not.toBeInTheDocument();
  });

  it('calls onEdit / onDelete / onTest', async () => {
    const onEdit = vi.fn(), onDelete = vi.fn(), onTest = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ConnectorCard connector={mockConnector} mode="view" onEdit={onEdit} onDelete={onDelete} onTest={onTest} onSubmit={vi.fn()} onFormTest={vi.fn()} />,
    );
    await user.click(screen.getByLabelText('Edit My ABS'));
    await user.click(screen.getByLabelText('Delete My ABS'));
    await user.click(screen.getByText('Test').closest('button')!);
    expect(onEdit).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
    expect(onTest).toHaveBeenCalledWith(1);
  });
});

describe('ConnectorCard — create mode', () => {
  it('renders the form with Audiobookshelf fields', () => {
    renderWithProviders(<ConnectorCard mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />);
    expect(screen.getByText('Add New Connector')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('http://audiobookshelf.local:13378')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
  });

  it('submits form data', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ConnectorCard mode="create" onSubmit={onSubmit} onFormTest={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('My Audiobookshelf'), 'Living Room ABS');
    await user.type(screen.getByPlaceholderText('http://audiobookshelf.local:13378'), 'http://abs.local');
    await user.type(screen.getByPlaceholderText('API key is required'), 'my-key');
    await user.type(screen.getByPlaceholderText('Library ID (or fetch)'), 'lib-1');
    await user.click(screen.getByText('Add Connector'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      name: 'Living Room ABS',
      type: 'audiobookshelf',
      settings: { baseUrl: 'http://abs.local', apiKey: 'my-key', libraryId: 'lib-1' },
    });
  });
});

describe('ConnectorCard — edit mode', () => {
  it('prefills, disables the type selector, and posts no id on Test (#827 shared hook injects it)', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ConnectorCard connector={mockConnector} mode="edit" onSubmit={vi.fn()} onFormTest={onFormTest} />);

    expect(screen.getByText('Edit Connector')).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toBeDisabled();

    await user.click(screen.getByText('Test').closest('button')!);
    await waitFor(() => expect(onFormTest).toHaveBeenCalled());

    const payload = onFormTest.mock.calls[0]![0];
    expect(payload).toMatchObject({ type: 'audiobookshelf' });
    expect(payload).not.toHaveProperty('id');
    // Strict-schema guard: settings carries only the connector's own keys.
    expect(Object.keys(payload.settings).sort()).toEqual(['apiKey', 'baseUrl', 'libraryId']);
  });
});

describe('ConnectorCard — field-scoped test errors (nested settings.* paths)', () => {
  // Deliver formTestResult AFTER mount, mirroring the real flow (the result arrives
  // when the user clicks Test, not at initial render).
  function Harness({ result }: { result: TestResult }) {
    const [r, setR] = useState<TestResult | null>(null);
    useEffect(() => { setR(result); }, [result]);
    return <ConnectorCard connector={mockConnector} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} formTestResult={r} />;
  }

  it.each([
    ['apiKey', 'API key rejected'],
    ['baseUrl', 'Cannot reach server'],
    ['libraryId', 'Library missing'],
  ])('maps fieldErrors.%s onto the rendered settings.%s input', async (field, message) => {
    const formTestResult = { success: false, message: 'Test failed', fieldErrors: { [field]: message } } as unknown as TestResult;
    renderWithProviders(<Harness result={formTestResult} />);
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});

describe('ConnectorCard — fetch libraries', () => {
  it('populates the library dropdown on success', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchConnectorTargets).mockResolvedValue([{ id: 'lib-1', name: 'Audiobooks' }, { id: 'lib-2', name: 'Kids' }]);

    renderWithProviders(<ConnectorCard connector={mockConnector} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} />);

    await user.click(screen.getByText('Fetch'));

    await waitFor(() => expect(screen.getByRole('option', { name: 'Audiobooks' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Kids' })).toBeInTheDocument();
  });

  it('surfaces a field-scoped error from a failed targets fetch', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchConnectorTargets).mockResolvedValue({ success: false, message: 'Auth failed', fieldErrors: { apiKey: 'Key invalid' } });

    renderWithProviders(<ConnectorCard connector={mockConnector} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} />);

    await user.click(screen.getByText('Fetch'));

    expect(await screen.findByText('Key invalid')).toBeInTheDocument();
  });
});

describe('ConnectorCard — Plex (registry-driven per-type fields)', () => {
  const plexConnector = createMockConnector({
    id: 2,
    name: 'My Plex',
    type: 'plex',
    settings: { baseUrl: '********', token: '********', sectionId: '1', pathMappings: [], fallbackToFullRefresh: false },
  });

  it('renders the Plex field set (token / section select / path mappings / fallback toggle) when type is Plex', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectorCard mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />);

    // ABS is the default; switching the type swaps the rendered field set (registry-driven).
    await user.selectOptions(screen.getByLabelText('Type'), 'plex');

    expect(screen.getByText('Plex Token')).toBeInTheDocument();
    expect(screen.getByText('Library Section')).toBeInTheDocument();
    expect(screen.getByText(/Path Mappings/)).toBeInTheDocument();
    // Copy must match the adapter contract: fallback fires for no-derivable-path
    // items, NOT for unmapped paths (those are passthrough). See F2 (#1502).
    expect(screen.getByText('Fall back to full section refresh when a path cannot be derived')).toBeInTheDocument();
    expect(screen.queryByText(/unmapped paths/)).not.toBeInTheDocument();
    expect(screen.getByText('Add Mapping')).toBeInTheDocument();
    // ABS-only field is gone.
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();
  });

  it('submits a path-mapping row in the correct shape', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ConnectorCard mode="create" onSubmit={onSubmit} onFormTest={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('Type'), 'plex');
    await user.type(screen.getByPlaceholderText('My Audiobookshelf'), 'Home Plex');
    await user.type(screen.getByPlaceholderText('http://plex.local:32400'), 'http://plex.local');
    await user.type(screen.getByPlaceholderText('X-Plex-Token'), 'tok-123');
    await user.type(screen.getByPlaceholderText('Library Section ID (or fetch)'), '1');
    await user.click(screen.getByText('Add Mapping'));
    await user.type(screen.getByPlaceholderText('/library/audiobooks'), '/lib');
    await user.type(screen.getByPlaceholderText('/data/audiobooks'), '/data');
    await user.click(screen.getByText('Add Connector'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      name: 'Home Plex',
      type: 'plex',
      settings: { baseUrl: 'http://plex.local', token: 'tok-123', sectionId: '1', pathMappings: [{ localPath: '/lib', serverPath: '/data' }] },
    });
  });

  it('populates the section dropdown from listTargets', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchConnectorTargets).mockResolvedValue([{ id: '1', name: 'Audiobooks' }, { id: '2', name: 'Music' }]);
    renderWithProviders(<ConnectorCard mode="create" onSubmit={vi.fn()} onFormTest={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('Type'), 'plex');
    await user.click(screen.getByText('Fetch'));

    await waitFor(() => expect(screen.getByRole('option', { name: 'Audiobooks' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Music' })).toBeInTheDocument();
  });

  it.each([
    ['token', 'Plex token rejected'],
    ['sectionId', 'Section missing'],
  ])('routes a Record fieldErrors.%s onto the Plex settings.%s input', async (field, message) => {
    function Harness() {
      const [r, setR] = useState<TestResult | null>(null);
      useEffect(() => { setR({ success: false, message: 'Test failed', fieldErrors: { [field]: message } } as unknown as TestResult); }, []);
      return <ConnectorCard connector={plexConnector} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} formTestResult={r} />;
    }
    renderWithProviders(<Harness />);
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('edit posts no id and settings carries only the Plex keys (#827 shared hook injects id)', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ConnectorCard connector={plexConnector} mode="edit" onSubmit={vi.fn()} onFormTest={onFormTest} />);

    await user.click(screen.getByText('Test').closest('button')!);
    await waitFor(() => expect(onFormTest).toHaveBeenCalled());

    const payload = onFormTest.mock.calls[0]![0];
    expect(payload).toMatchObject({ type: 'plex' });
    expect(payload).not.toHaveProperty('id');
    expect(Object.keys(payload.settings).sort()).toEqual(['baseUrl', 'fallbackToFullRefresh', 'pathMappings', 'sectionId', 'token']);
  });
});
