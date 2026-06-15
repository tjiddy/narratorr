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
  it('displays name and type/host subtitle', () => {
    renderWithProviders(<ConnectorCard connector={mockConnector} mode="view" onSubmit={vi.fn()} onFormTest={vi.fn()} />);
    expect(screen.getByText('My ABS')).toBeInTheDocument();
    expect(screen.getByText(/Audiobookshelf — abs\.local/)).toBeInTheDocument();
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
    await user.type(screen.getByPlaceholderText('Library ID (or fetch libraries)'), 'lib-1');
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

    await user.click(screen.getByText('Fetch Libraries'));

    await waitFor(() => expect(screen.getByRole('option', { name: 'Audiobooks' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Kids' })).toBeInTheDocument();
  });

  it('surfaces a field-scoped error from a failed targets fetch', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchConnectorTargets).mockResolvedValue({ success: false, message: 'Auth failed', fieldErrors: { apiKey: 'Key invalid' } });

    renderWithProviders(<ConnectorCard connector={mockConnector} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} />);

    await user.click(screen.getByText('Fetch Libraries'));

    expect(await screen.findByText('Key invalid')).toBeInTheDocument();
  });
});
