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
    // Override formatBytes with a KB-only formatter that existing assertions depend on.
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
      <BackupTable backups={undefined} isLoading={true} onDownload={vi.fn()} onRestore={vi.fn()} />,
    );
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('renders empty state when backups array is empty', () => {
    renderWithProviders(
      <BackupTable backups={[]} isLoading={false} onDownload={vi.fn()} onRestore={vi.fn()} />,
    );
    expect(screen.getByText(/no backups yet/i)).toBeInTheDocument();
  });

  it('renders empty state when backups is undefined', () => {
    renderWithProviders(
      <BackupTable backups={undefined} isLoading={false} onDownload={vi.fn()} onRestore={vi.fn()} />,
    );
    expect(screen.getByText(/no backups yet/i)).toBeInTheDocument();
  });

  it('renders backup rows with filename and size', () => {
    renderWithProviders(
      <BackupTable backups={mockBackups} isLoading={false} onDownload={vi.fn()} onRestore={vi.fn()} />,
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
      // PHASE 1 SKIPPED — needs human review
      <BackupTable backups={[mockBackups[0]]} isLoading={false} onDownload={onDownload} onRestore={vi.fn()} />,
    );

    const downloadButton = screen.getByTitle('Download backup');
    await user.click(downloadButton);

    expect(onDownload).toHaveBeenCalledWith(mockBackups[0]);
  });

  it('renders restore icon button per backup row alongside download', () => {
    renderWithProviders(
      <BackupTable backups={mockBackups} isLoading={false} onDownload={vi.fn()} onRestore={vi.fn()} />,
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
      // PHASE 1 SKIPPED — needs human review
      <BackupTable backups={[mockBackups[0]]} isLoading={false} onDownload={vi.fn()} onRestore={onRestore} />,
    );

    const restoreButton = screen.getByTitle('Restore backup');
    await user.click(restoreButton);

    expect(onRestore).toHaveBeenCalledWith(mockBackups[0]);
  });

  it('restore buttons remain enabled so user can click a different backup while one is validating', async () => {
    const onRestore = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <BackupTable backups={mockBackups} isLoading={false} onDownload={vi.fn()} onRestore={onRestore} />,
    );

    const restoreButtons = screen.getAllByTitle('Restore backup');

    // Click first backup's restore
    await user.click(restoreButtons[0]!);
    expect(onRestore).toHaveBeenCalledWith(mockBackups[0]);

    // Click second backup's restore — buttons are still enabled
    await user.click(restoreButtons[1]!);
    expect(onRestore).toHaveBeenCalledWith(mockBackups[1]);
    expect(onRestore).toHaveBeenCalledTimes(2);
  });
});
