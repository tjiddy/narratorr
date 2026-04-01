import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockIndexer } from '@/__tests__/factories';
import { IndexerCard } from './IndexerCard';
import type { Indexer, TestResult } from '@/lib/api';
import type { IdTestResult } from './SettingsCardShell';

const mockIndexer: Indexer = createMockIndexer({ id: 1 });

const mockTorznabIndexer: Indexer = createMockIndexer({
  id: 2,
  name: 'My Torznab',
  type: 'torznab',
  enabled: false,
  priority: 30,
  settings: { apiUrl: 'https://indexer.example.com/api', apiKey: 'secret123' },
});

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

  it('updates Name field placeholder to match selected type display name when type changes', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('AudioBookBay')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 'torznab');

    expect(screen.getByPlaceholderText('Torznab')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('AudioBookBay')).not.toBeInTheDocument();
  });

  it('shows performance hint when ABB type is selected', () => {
    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText(/Large library, but slower and less reliable/)).toBeInTheDocument();
  });

  it('hides performance hint when non-ABB type is selected', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox'), 'torznab');

    expect(screen.queryByText(/Large library, but slower and less reliable/)).not.toBeInTheDocument();
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

  it('pre-fills MAM fields when editing a myanonamouse indexer', () => {
    const mamIndexer: Indexer = createMockIndexer({
      id: 5,
      name: 'My MAM',
      type: 'myanonamouse',
      settings: { mamId: 'secret-mam-id', baseUrl: 'https://mam.example.com' },
    });

    renderWithProviders(
      <IndexerCard
        indexer={mamIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('MAM ID')).toHaveValue('secret-mam-id');
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://mam.example.com');
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

  it("shows placeholder matching the indexer's configured type, not the default type", () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockTorznabIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Torznab')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('AudioBookBay')).not.toBeInTheDocument();
  });
});

describe('IndexerCard — Prowlarr-managed indicators (AC8)', () => {
  const prowlarrIndexer: Indexer = createMockIndexer({
    id: 10,
    name: 'Prowlarr Torznab',
    type: 'torznab',
    source: 'prowlarr',
    sourceIndexerId: 5,
    settings: { apiUrl: 'http://prowlarr:9696/5/', apiKey: 'abc123' },
  });

  it('shows Prowlarr badge/indicator when indexer has source: "prowlarr"', () => {
    renderWithProviders(
      <IndexerCard
        indexer={prowlarrIndexer}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Managed by Prowlarr')).toBeInTheDocument();
  });

  it('does not show Prowlarr indicator for manually-created indexers (source: null)', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockTorznabIndexer}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.queryByText('Managed by Prowlarr')).not.toBeInTheDocument();
  });

  it('makes name field read-only for Prowlarr-managed indexers in edit mode', () => {
    renderWithProviders(
      <IndexerCard
        indexer={prowlarrIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const nameInput = screen.getByLabelText('Name');
    expect(nameInput).toHaveAttribute('readonly');
  });

  it('makes API URL and API Key fields read-only for Prowlarr-managed indexers in edit mode', () => {
    renderWithProviders(
      <IndexerCard
        indexer={prowlarrIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const apiUrlInput = screen.getByLabelText('API URL');
    const apiKeyInput = screen.getByLabelText('API Key');
    expect(apiUrlInput).toHaveAttribute('readonly');
    expect(apiKeyInput).toHaveAttribute('readonly');
  });

  it('keeps priority and enabled fields editable for Prowlarr-managed indexers', () => {
    renderWithProviders(
      <IndexerCard
        indexer={prowlarrIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const priorityInput = screen.getByLabelText('Priority');
    const enabledInput = screen.getByLabelText('Enabled');
    expect(priorityInput).not.toHaveAttribute('readonly');
    expect(enabledInput).not.toHaveAttribute('readonly');
  });

  it('all fields remain editable for manually-created indexers', () => {
    renderWithProviders(
      <IndexerCard
        indexer={mockTorznabIndexer}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    const nameInput = screen.getByLabelText('Name');
    const apiUrlInput = screen.getByLabelText('API URL');
    expect(nameInput).not.toHaveAttribute('readonly');
    expect(apiUrlInput).not.toHaveAttribute('readonly');
  });

  describe('SelectWithChevron migration (#224)', () => {
    it('type select in edit mode renders with appearance-none and ChevronDownIcon', () => {
      renderWithProviders(
        <IndexerCard
          indexer={mockIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      const select = screen.getByLabelText('Type');
      expect(select.className).toContain('appearance-none');
      const selectParent = select.parentElement!;
      expect(selectParent.querySelector('svg')).not.toBeNull();
    });

    it('selecting an indexer type via SelectWithChevron updates form state', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <IndexerCard
          indexer={mockIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      await user.selectOptions(screen.getByLabelText('Type'), 'torznab');
      expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('torznab');
    });

    it('type select shows border-destructive when errors.type is present', async () => {
      const user = userEvent.setup();
      const invalidIndexer = createMockIndexer({ type: 'INVALID' as never });
      renderWithProviders(
        <IndexerCard
          indexer={invalidIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      const select = screen.getByLabelText('Type');
      expect(select.className).toContain('border-border');
      expect(select.className).not.toContain('border-destructive');

      await user.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => {
        expect(screen.getByLabelText('Type').className).toContain('border-destructive');
      });
    });
  });
});
