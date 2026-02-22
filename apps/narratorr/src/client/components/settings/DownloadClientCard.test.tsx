import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockDownloadClient } from '@/__tests__/factories';
import { DownloadClientCard } from './DownloadClientCard';
import type { DownloadClient, TestResult } from '@/lib/api';
import type { IdTestResult } from './SettingsCardShell';

const mockClient: DownloadClient = createMockDownloadClient({ id: 1, name: 'My qBit' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadClientCard — view mode', () => {
  it('displays client name and host:port subtitle', () => {
    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="view"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('My qBit')).toBeInTheDocument();
    expect(screen.getByText('localhost:8080')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="view"
        onEdit={onEdit}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('Edit My qBit'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('calls onDelete when delete button is clicked', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="view"
        onDelete={onDelete}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('Delete My qBit'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('calls onTest with client id', async () => {
    const onTest = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="view"
        onTest={onTest}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.click(screen.getByText('Test').closest('button')!);
    expect(onTest).toHaveBeenCalledWith(1);
  });

  it('shows test result when id matches', () => {
    const testResult: IdTestResult = { id: 1, success: true, message: 'Connected' };

    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="view"
        testResult={testResult}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Connected')).toBeInTheDocument();
  });
});

describe('DownloadClientCard — create mode', () => {
  it('renders form with Add Download Client heading', () => {
    renderWithProviders(
      <DownloadClientCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Add Download Client')).toBeInTheDocument();
  });

  it('shows host, port, username, password fields for qbittorrent', () => {
    renderWithProviders(
      <DownloadClientCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('Use SSL/HTTPS')).toBeInTheDocument();
  });

  it('shows API Key field for sabnzbd type', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <DownloadClientCard
        mode="create"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox'), 'sabnzbd');

    expect(screen.getByText('API Key')).toBeInTheDocument();
    expect(screen.queryByText('Username')).not.toBeInTheDocument();
    expect(screen.queryByText('Password')).not.toBeInTheDocument();
  });

  it('submits form data', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <DownloadClientCard
        mode="create"
        onSubmit={onSubmit}
        onFormTest={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText('qBittorrent'), 'Test Client');
    await user.type(screen.getByPlaceholderText('localhost'), 'myhost');
    await user.click(screen.getByText('Add Client'));

    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Test Client',
      type: 'qbittorrent',
      settings: expect.objectContaining({ host: 'myhost' }),
    });
  });

  it('shows Adding... when isPending', () => {
    renderWithProviders(
      <DownloadClientCard
        mode="create"
        isPending={true}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Adding...')).toBeInTheDocument();
  });

  it('shows form test result', () => {
    const formTestResult: TestResult = { success: false, message: 'Connection refused' };

    renderWithProviders(
      <DownloadClientCard
        mode="create"
        formTestResult={formTestResult}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });
});

describe('DownloadClientCard — edit mode', () => {
  it('renders form with Edit heading and pre-filled data', () => {
    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Edit Download Client')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('qBittorrent')).toHaveValue('My qBit');
    expect(screen.getByPlaceholderText('localhost')).toHaveValue('localhost');
  });

  it('shows enabled and priority fields', () => {
    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  it('shows cancel button and calls onCancel', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
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
      <DownloadClientCard
        client={mockClient}
        mode="edit"
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('shows Saving... when isPending', () => {
    renderWithProviders(
      <DownloadClientCard
        client={mockClient}
        mode="edit"
        isPending={true}
        onSubmit={vi.fn()}
        onFormTest={vi.fn()}
      />,
    );

    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });
});
