import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { BackupTable } from './BackupTable';
import type { BackupMetadata } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    // Override formatBytes with a deterministic KB-only formatter.
    formatBytes: (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`,
  };
});

const mockBackups: BackupMetadata[] = [
  { filename: 'narratorr-backup-20260101T000000000Z.zip', timestamp: '2026-01-01T00:00:00Z', size: 102400 },
  { filename: 'narratorr-backup-20260102T000000000Z.zip', timestamp: '2026-01-02T00:00:00Z', size: 204800 },
];

describe('BackupTable', () => {
  it('renders loading spinner when isLoading is true', () => {
    renderWithProviders(
      <BackupTable backups={undefined} isLoading={true} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('renders empty state when backups array is empty', () => {
    renderWithProviders(
      <BackupTable backups={[]} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByText(/no backups yet/i)).toBeInTheDocument();
  });

  it('renders empty state when backups is undefined', () => {
    renderWithProviders(
      <BackupTable backups={undefined} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByText(/no backups yet/i)).toBeInTheDocument();
  });

  it('renders backup rows with filename and size', () => {
    renderWithProviders(
      <BackupTable backups={mockBackups} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByText('narratorr-backup-20260101T000000000Z.zip')).toBeInTheDocument();
    expect(screen.getByText('narratorr-backup-20260102T000000000Z.zip')).toBeInTheDocument();
    expect(screen.getByText('100.0 KB')).toBeInTheDocument();
    expect(screen.getByText('200.0 KB')).toBeInTheDocument();
  });

  it('calls onDownload when download button is clicked', async () => {
    const onDownload = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <BackupTable backups={[mockBackups[0]!]} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={onDownload} onRestore={vi.fn()} onDelete={vi.fn()} />,
    );

    const downloadButton = screen.getByTitle('Download backup');
    await user.click(downloadButton);

    expect(onDownload).toHaveBeenCalledWith(mockBackups[0]);
  });

  it('renders restore icon button per backup row alongside download', () => {
    renderWithProviders(
      <BackupTable backups={mockBackups} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
    );

    const restoreButtons = screen.getAllByTitle('Restore backup');
    expect(restoreButtons).toHaveLength(2);
    const downloadButtons = screen.getAllByTitle('Download backup');
    expect(downloadButtons).toHaveLength(2);
  });

  it('calls onRestore with backup metadata when restore button is clicked', async () => {
    const onRestore = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <BackupTable backups={[mockBackups[0]!]} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={onRestore} onDelete={vi.fn()} />,
    );

    const restoreButton = screen.getByTitle('Restore backup');
    await user.click(restoreButton);

    expect(onRestore).toHaveBeenCalledWith(mockBackups[0]);
  });

  it('renders a Delete button per backup row with destructive hover styling', () => {
    renderWithProviders(
      <BackupTable backups={mockBackups} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
    );

    const deleteButtons = screen.getAllByTitle('Delete backup');
    expect(deleteButtons).toHaveLength(2);
    expect(deleteButtons[0]!.className).toContain('hover:text-destructive');
    expect(deleteButtons[0]!.className).toContain('hover:bg-destructive/10');
  });

  it('calls onDelete with backup metadata when delete button is clicked', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <BackupTable backups={[mockBackups[0]!]} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={onDelete} />,
    );

    const deleteButton = screen.getByTitle('Delete backup');
    await user.click(deleteButton);

    expect(onDelete).toHaveBeenCalledWith(mockBackups[0]);
  });

  it('restore buttons remain enabled so user can click a different backup while one is validating', async () => {
    const onRestore = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <BackupTable backups={mockBackups} isLoading={false} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={onRestore} onDelete={vi.fn()} />,
    );

    const restoreButtons = screen.getAllByTitle('Restore backup');

    await user.click(restoreButtons[0]!);
    expect(onRestore).toHaveBeenCalledWith(mockBackups[0]);

    await user.click(restoreButtons[1]!);
    expect(onRestore).toHaveBeenCalledWith(mockBackups[1]);
    expect(onRestore).toHaveBeenCalledTimes(2);
  });
  describe('when the backup read fails', () => {
    it('reports the read failure instead of claiming there are no backups', () => {
      renderWithProviders(
        <BackupTable backups={undefined} isLoading={false} isError={true} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
      );

      expect(screen.getByText('Failed to load backups.')).toBeInTheDocument();
      // The distinction the operator needs: a failed read is not an empty backup directory.
      expect(screen.queryByText(/no backups yet/i)).not.toBeInTheDocument();
    });

    it('reports the failure ahead of a stale list the failed read could not confirm', () => {
      renderWithProviders(
        <BackupTable backups={mockBackups} isLoading={false} isError={true} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
      );

      expect(screen.getByText('Failed to load backups.')).toBeInTheDocument();
      expect(screen.queryByText('narratorr-backup-20260101T000000000Z.zip')).not.toBeInTheDocument();
    });

    it('calls onRetry when the operator clicks the surface-named Retry control', async () => {
      const onRetry = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <BackupTable backups={undefined} isLoading={false} isError={true} onRetry={onRetry} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
      );

      await user.click(screen.getByRole('button', { name: 'Retry loading backups' }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps the loading spinner ahead of the error while the first read is still in flight', () => {
      renderWithProviders(
        <BackupTable backups={undefined} isLoading={true} isError={false} onRetry={vi.fn()} onDownload={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} />,
      );

      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
      expect(screen.queryByText('Failed to load backups.')).not.toBeInTheDocument();
    });
  });
});
