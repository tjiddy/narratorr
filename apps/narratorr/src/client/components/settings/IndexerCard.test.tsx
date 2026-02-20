import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { IndexerCard } from './IndexerCard';
import type { Indexer, TestResult } from '@/lib/api';
import type { IdTestResult } from './SettingsCardShell';

const mockIndexer: Indexer = {
  id: 1,
  name: 'My ABB',
  type: 'abb',
  enabled: true,
  priority: 50,
  settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
  createdAt: '2024-01-01T00:00:00Z',
};

const mockTorznabIndexer: Indexer = {
  id: 2,
  name: 'My Torznab',
  type: 'torznab',
  enabled: false,
  priority: 30,
  settings: { apiUrl: 'https://indexer.example.com/api', apiKey: 'secret123' },
  createdAt: '2024-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IndexerCard — view mode', () => {
  it('displays indexer name and subtitle', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('My ABB')).toBeInTheDocument();
    expect(screen.getByText('audiobookbay.lu')).toBeInTheDocument();
  });

  it('shows API URL as subtitle for torznab indexers', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockTorznabIndexer}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('https://indexer.example.com/api')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="view"
        onEdit={onEdit}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('Edit My ABB'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('calls onDelete when delete button is clicked', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="view"
        onDelete={onDelete}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('Delete My ABB'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('calls onTest with indexer id when test button is clicked', async () => {
    const onTest = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="view"
        onTest={onTest}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByText('Test').closest('button')!);
    expect(onTest).toHaveBeenCalledWith(1);
  });

  it('shows test result when testResult matches indexer id', () => {
    const testResult: IdTestResult = { id: 1, success: true, message: 'All good' };

    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="view"
        testResult={testResult}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('does not show test result for different indexer id', () => {
    const testResult: IdTestResult = { id: 99, success: true, message: 'Wrong one' };

    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="view"
        testResult={testResult}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.queryByText('Wrong one')).not.toBeInTheDocument();
  });
});

describe('IndexerCard — create mode', () => {
  it('renders form with Add New Indexer heading', () => {
    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Add New Indexer')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('AudioBookBay')).toBeInTheDocument();
  });

  it('shows ABB fields by default', () => {
    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('audiobookbay.lu')).toBeInTheDocument();
    expect(screen.getByText('Page Limit')).toBeInTheDocument();
  });

  it('shows torznab fields when type is changed', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox'), 'torznab');

    expect(screen.getByPlaceholderText('https://indexer.example.com/api')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('audiobookbay.lu')).not.toBeInTheDocument();
  });

  it('does not show enabled/priority fields in create mode', () => {
    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();
  });

  it('submits form data when Add Indexer is clicked', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={onSubmit}
        onFormTest={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'Test Indexer');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    await user.click(screen.getByText('Add Indexer'));

    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Test Indexer',
      type: 'abb',
      settings: expect.objectContaining({ hostname: 'example.com' }),
    });
  });

  it('calls onFormTest when test button is clicked', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={onFormTest}
      />,
    );

    await user.type(screen.getByPlaceholderText('AudioBookBay'), 'Test');
    await user.type(screen.getByPlaceholderText('audiobookbay.lu'), 'example.com');
    await user.click(screen.getByText('Test'));

    expect(onFormTest).toHaveBeenCalled();
  });

  it('shows form test result', () => {
    const formTestResult: TestResult = { success: false, message: 'Connection refused' };

    renderWithProviders(
      <IndexerCard
        mode="create"
        formTestResult={formTestResult}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  it('shows saving state on submit button', () => {
    renderWithProviders(
      <IndexerCard
        mode="create"
        isPending={true}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Adding...')).toBeInTheDocument();
  });
});

describe('IndexerCard — edit mode', () => {
  it('renders form with Edit Indexer heading', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Edit Indexer')).toBeInTheDocument();
  });

  it('shows enabled and priority fields', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  it('pre-fills form with indexer data', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('AudioBookBay')).toHaveValue('My ABB');
    expect(screen.getByPlaceholderText('audiobookbay.lu')).toHaveValue('audiobookbay.lu');
  });

  it('shows cancel button and calls onCancel', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="edit"
        onCancel={onCancel}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows Save Changes on submit button', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('shows Saving... when isPending', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockIndexer}
        mode="edit"
        isPending={true}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });
});
