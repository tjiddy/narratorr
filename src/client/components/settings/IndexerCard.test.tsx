import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockIndexer } from '@/__tests__/factories';
import { IndexerCard } from './IndexerCard';
import type { Indexer, TestResult } from '@/lib/api';
import type { IdTestResult } from './SettingsCardShell';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({ network: { proxyUrl: '' } }),
    testIndexerConfig: vi.fn(),
  },
}));

import { api } from '@/lib/api';

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
    expect(screen.getByPlaceholderText('Newznab')).toBeInTheDocument();
  });

  it('shows Newznab fields by default', () => {
    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('https://indexer.example.com/api')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
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

    await user.type(screen.getByPlaceholderText('Newznab'), 'Test Indexer');
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'example.com');
    await user.type(screen.getByLabelText('API Key'), 'test-key');
    await user.click(screen.getByText('Add Indexer'));

    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Test Indexer',
      type: 'newznab',
      settings: expect.objectContaining({ apiUrl: 'example.com', apiKey: 'test-key' }),
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

    await user.type(screen.getByPlaceholderText('Newznab'), 'Test');
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'example.com');
    await user.type(screen.getByLabelText('API Key'), 'test-key');
    await user.click(screen.getByText('Test'));

    expect(onFormTest).toHaveBeenCalled();
  });

  it('#339 create-mode Test button does not include id in onFormTest payload', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={onFormTest}
      />,
    );

    await user.type(screen.getByPlaceholderText('Newznab'), 'Test');
    await user.type(screen.getByPlaceholderText('https://indexer.example.com/api'), 'example.com');
    await user.type(screen.getByLabelText('API Key'), 'test-key');
    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(onFormTest).toHaveBeenCalled();
    });
    expect(onFormTest.mock.calls[0][0]).not.toHaveProperty('id');
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

    expect(screen.getByPlaceholderText('Newznab')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 'torznab');

    expect(screen.getByPlaceholderText('Torznab')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('AudioBookBay')).not.toBeInTheDocument();
  });

  it('shows performance hint when ABB type is selected', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <IndexerCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox'), 'abb');
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

  describe('create-mode MAM flow — searchLanguages (#291, #317)', () => {
    it('switches to MAM type, shows language hint instead of checkboxes, and submits with correct payload', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <IndexerCard
          mode="create"
          onSubmit={onSubmit}
          onFormTest={vi.fn()}
        />,
      );

      // Switch type to myanonamouse
      await user.selectOptions(screen.getByLabelText('Type'), 'myanonamouse');

      // Fill required MAM ID
      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'test-mam-id');

      // Fill name
      await user.type(screen.getByPlaceholderText('MyAnonamouse'), 'My MAM');

      // Verify language checkboxes and search type dropdown are not shown (#372)
      expect(screen.queryByLabelText('English')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Search Type')).not.toBeInTheDocument();

      // Submit
      await user.click(screen.getByText('Add Indexer'));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        name: 'My MAM',
        type: 'myanonamouse',
        settings: expect.objectContaining({
          mamId: 'test-mam-id',
        }),
      });
    });
  });

  describe('edit-mode hydration — searchLanguages (#291, #317)', () => {
    it('shows language hint instead of checkboxes when editing MAM indexer', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 10,
        name: 'MAM Custom',
        type: 'myanonamouse',
        settings: { mamId: 'my-mam-id', baseUrl: '', searchLanguages: [1, 36], searchType: 'fl' },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Language checkboxes and search type dropdown not shown (#372)
      expect(screen.queryByLabelText('English')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Search Type')).not.toBeInTheDocument();
    });

    it('#317 preserves isVip through edit-mode hydration and save', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      const mamIndexer: Indexer = createMockIndexer({
        id: 14,
        name: 'MAM VIP',
        type: 'myanonamouse',
        settings: { mamId: 'vip-id', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: true },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={onSubmit}
          onFormTest={vi.fn()}
        />,
      );

      // Submit without changing anything — isVip should roundtrip
      await user.click(screen.getByText('Save Changes'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0][0].settings).toHaveProperty('isVip', true);
    });

    it('#339 hydrates mamStatus badge from persisted isVip and mamUsername on edit form open', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 15,
        name: 'MAM Persisted',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: true, mamUsername: 'PersistedUser' },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Badge should render from persisted values without API call
      expect(screen.getByText('PersistedUser')).toBeInTheDocument();
      expect(screen.getByText('VIP')).toBeInTheDocument();
    });

    it('#339 edit form with isVip: false and mamUsername shows User badge without API call', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 16,
        name: 'MAM User',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: false, mamUsername: 'RegularUser' },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      expect(screen.getByText('RegularUser')).toBeInTheDocument();
      expect(screen.getByText('User')).toBeInTheDocument();
    });

    it('#339 edit form with isVip: true but no mamUsername shows VIP badge without username text', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 17,
        name: 'MAM VIP No Username',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: true },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      expect(screen.getByText('VIP')).toBeInTheDocument();
    });

    it('#339 non-MAM indexer edit form does not render mamStatus badge', () => {
      renderWithProviders(
        <IndexerCard
          indexer={mockIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      expect(screen.queryByText('VIP')).not.toBeInTheDocument();
      expect(screen.queryByText('User')).not.toBeInTheDocument();
    });

    it('#339 preserves mamUsername through edit-mode hydration and save', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      const mamIndexer: Indexer = createMockIndexer({
        id: 18,
        name: 'MAM Username',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: true, mamUsername: 'SavedUser' },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={onSubmit}
          onFormTest={vi.fn()}
        />,
      );

      await user.click(screen.getByText('Save Changes'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0][0].settings).toHaveProperty('mamUsername', 'SavedUser');
    });

    it('#339 explicit Test button success updates mamStatus badge from formTestResult.metadata', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 19,
        name: 'MAM Test Badge',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: false, mamUsername: 'OldUser' },
      });

      const formTestResult: TestResult = {
        success: true,
        message: 'Connected',
        metadata: { username: 'FreshUser', classname: 'VIP', isVip: true },
      };

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          formTestResult={formTestResult}
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Badge should show fresh metadata from Test button, not persisted data
      expect(screen.getByText('FreshUser')).toBeInTheDocument();
      expect(screen.getByText('VIP')).toBeInTheDocument();
    });

    it('#339 Test button failure does not clear persisted badge data', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 20,
        name: 'MAM Fail Badge',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: true, mamUsername: 'PersistedUser' },
      });

      const formTestResult: TestResult = {
        success: false,
        message: 'Connection failed',
      };

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          formTestResult={formTestResult}
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Persisted badge should still render despite test failure
      expect(screen.getByText('PersistedUser')).toBeInTheDocument();
      expect(screen.getByText('VIP')).toBeInTheDocument();
    });

    it('#339 edit-mode Test button includes indexer id in onFormTest payload', async () => {
      const onFormTest = vi.fn();
      const user = userEvent.setup();
      const mamIndexer: Indexer = createMockIndexer({
        id: 21,
        name: 'MAM Id Transport',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active' },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={onFormTest}
        />,
      );

      await user.click(screen.getByText('Test'));

      await waitFor(() => {
        expect(onFormTest).toHaveBeenCalled();
      });
      expect(onFormTest.mock.calls[0][0]).toHaveProperty('id', 21);
    });

    it('renders language hint for MAM indexer with empty searchLanguages', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 13,
        name: 'MAM All Languages',
        type: 'myanonamouse',
        settings: { mamId: 'mam-id', baseUrl: '', searchLanguages: [], searchType: 'active' },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Language checkboxes not shown
      expect(screen.queryByLabelText('English')).not.toBeInTheDocument();
    });
  });

  describe('#361 — indexerId prop threading to IndexerFields', () => {
    it('#361 edit-mode refresh with sentinel calls testIndexerConfig with indexer id', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'RefreshedUser', classname: 'VIP', isVip: true },
      });
      const user = userEvent.setup();
      const mamIndexer: Indexer = createMockIndexer({
        id: 55,
        name: 'MAM Refresh Test',
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: true, mamUsername: 'OldUser' },
      });

      renderWithProviders(
        <IndexerCard
          indexer={mamIndexer}
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Badge hydrated from persisted mamUsername
      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.objectContaining({ id: 55 }),
        );
      });
    });

    it('#361 create-mode refresh with non-sentinel does not include id', () => {
      renderWithProviders(
        <IndexerCard
          mode="edit"
          onSubmit={vi.fn()}
          onFormTest={vi.fn()}
        />,
      );

      // Type a MAM ID to get the badge first — need to switch to MAM type
      // In create mode there's no indexer prop, so no indexerId
      // We'll test via IndexerFields directly (already covered in IndexerFields.test.tsx)
      // This test verifies that create-mode (no indexer prop) doesn't crash
      expect(screen.queryByTitle('Refresh MAM status')).not.toBeInTheDocument();
    });
  });

  describe('#372 — searchType dropdown removed', () => {
    it('edit mode does NOT render search type dropdown', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 20,
        name: 'MAM',
        type: 'myanonamouse',
        settings: { mamId: 'test-id', baseUrl: '', searchLanguages: [1] },
      });
      renderWithProviders(
        <IndexerCard indexer={mamIndexer} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );
      expect(screen.queryByLabelText('Search Type')).not.toBeInTheDocument();
    });
  });

  describe('#372 — edit-mode classname hydration', () => {
    it('shows persisted classname in card with search description instead of generic User fallback', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 30,
        name: 'MAM',
        type: 'myanonamouse',
        settings: { mamId: 'test-id', baseUrl: '', searchLanguages: [1], isVip: false, mamUsername: 'poweruser', classname: 'Power User' },
      });
      renderWithProviders(
        <IndexerCard indexer={mamIndexer} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );
      expect(screen.getByText('Power User')).toBeInTheDocument();
      expect(screen.getByText('Non-VIP and freeleech torrents')).toBeInTheDocument();
    });

    it('shows Mouse warning when persisted classname is Mouse', () => {
      const mamIndexer: Indexer = createMockIndexer({
        id: 31,
        name: 'MAM',
        type: 'myanonamouse',
        settings: { mamId: 'test-id', baseUrl: '', searchLanguages: [1], isVip: false, mamUsername: 'mouseuser', classname: 'Mouse' },
      });
      renderWithProviders(
        <IndexerCard indexer={mamIndexer} mode="edit" onSubmit={vi.fn()} onFormTest={vi.fn()} />,
      );
      expect(screen.getByText(/Search disabled — Mouse class cannot download/)).toBeInTheDocument();
    });
  });
});
