import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { SystemSettings } from './SystemSettings';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getBackups: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    createBackup: vi.fn(),
    getBackupDownloadUrl: vi.fn((filename: string) => `/api/system/backups/${filename}/download`),
    uploadRestore: vi.fn(),
    restoreBackupDirect: vi.fn(),
    confirmRestore: vi.fn(),
    getHealthStatus: vi.fn().mockResolvedValue([]),
    getHealthSummary: vi.fn().mockResolvedValue({ state: 'healthy' }),
    getSystemTasks: vi.fn().mockResolvedValue([]),
    getSystemInfo: vi.fn().mockResolvedValue({ version: '0.1.0', commit: 'unknown', nodeVersion: 'v20.0.0', os: 'linux', dbSize: 1024, libraryPath: '/books', freeSpace: 100000000000 }),
  },
  formatBytes: vi.fn((bytes: number) => `${(bytes / 1024).toFixed(1)} KB`),
}));

// Import mocked modules after mock setup
const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
const mockApi = api as unknown as {
  getBackups: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  createBackup: ReturnType<typeof vi.fn>;
  uploadRestore: ReturnType<typeof vi.fn>;
  restoreBackupDirect: ReturnType<typeof vi.fn>;
  confirmRestore: ReturnType<typeof vi.fn>;
};

describe('SystemSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue({
      system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
    });
  });

  describe('backup list', () => {
    it('shows empty state when no backups exist', async () => {
      mockApi.getBackups.mockResolvedValue([]);

      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/no backups yet/i)).toBeInTheDocument();
      });
    });

    it('renders backup list with filename, date, and size', async () => {
      mockApi.getBackups.mockResolvedValue([
        { filename: 'narratorr-backup-20260101T000000000Z.zip', timestamp: '2026-01-01T00:00:00Z', size: 102400 },
      ]);

      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText('narratorr-backup-20260101T000000000Z.zip')).toBeInTheDocument();
      });
    });

    it('Create Backup button triggers mutation and shows success toast', async () => {
      mockApi.getBackups.mockResolvedValue([]);
      mockApi.createBackup.mockResolvedValue({ created: true, pruned: 0 });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/create backup/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/create backup/i));

      await waitFor(() => {
        expect(mockApi.createBackup).toHaveBeenCalled();
      });
    });
  });

  describe('create backup mutation', () => {
    it('shows success toast after successful backup creation', async () => {
      mockApi.getBackups.mockResolvedValue([]);
      mockApi.createBackup.mockResolvedValue({ created: true, pruned: 0 });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/create backup/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/create backup/i));

      await waitFor(() => {
        expect(mockApi.createBackup).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('Backup created'));
      });

      // Cache invalidation causes backup list to be refetched
      await waitFor(() => {
        expect(mockApi.getBackups.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('shows error toast after failed backup creation', async () => {
      mockApi.getBackups.mockResolvedValue([]);
      mockApi.createBackup.mockRejectedValue(new Error('Disk full'));

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/create backup/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/create backup/i));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Disk full');
      });
    });
  });

  describe('download side effect', () => {
    it('creates anchor element with correct href and download attribute and clicks it', async () => {
      const backupEntry = {
        filename: 'narratorr-backup-20260101T000000000Z.zip',
        timestamp: '2026-01-01T00:00:00Z',
        size: 102400,
      };
      mockApi.getBackups.mockResolvedValue([backupEntry]);

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(backupEntry.filename)).toBeInTheDocument();
      });

      // Set up spy after render to avoid interfering with React's createElement calls
      const mockAnchor = {
        href: '',
        download: '',
        click: vi.fn(),
      };
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'a') return mockAnchor as unknown as HTMLAnchorElement;
        return originalCreateElement(tag);
      });

      await user.click(screen.getByTitle('Download backup'));

      expect(createElementSpy).toHaveBeenCalledWith('a');
      expect(mockAnchor.href).toBe(`/api/system/backups/${backupEntry.filename}/download`);
      expect(mockAnchor.download).toBe(backupEntry.filename);
      expect(mockAnchor.click).toHaveBeenCalled();

      createElementSpy.mockRestore();
    });
  });

  describe('restore flow', () => {
    it('uploading valid zip shows confirmation modal', async () => {
      mockApi.getBackups.mockResolvedValue([]);
      mockApi.uploadRestore.mockResolvedValue({ valid: true, backupMigrationCount: 2, appMigrationCount: 2 });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/restore from backup/i)).toBeInTheDocument();
      });

      // Create a mock file and trigger upload
      const file = new File(['fake-zip-content'], 'backup.zip', { type: 'application/zip' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, file);

      await waitFor(() => {
        expect(screen.getByText(/confirm restore/i)).toBeInTheDocument();
      });

      // Modal shows supervisor/manual restart warning
      expect(screen.getByText(/process supervisor/i)).toBeInTheDocument();
      expect(screen.getByText(/restart manually/i)).toBeInTheDocument();

      // Modal shows migration counts
      expect(screen.getByText(/2 migrations/i)).toBeInTheDocument();
    });

    it('uploading invalid file shows error toast', async () => {
      mockApi.getBackups.mockResolvedValue([]);
      mockApi.uploadRestore.mockRejectedValue(new Error('Invalid database file'));

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/restore from backup/i)).toBeInTheDocument();
      });

      const file = new File(['bad-data'], 'backup.zip', { type: 'application/zip' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, file);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Invalid database file');
      });
    });

    it('confirm restore calls api and closes modal', async () => {
      mockApi.getBackups.mockResolvedValue([]);
      mockApi.uploadRestore.mockResolvedValue({ valid: true, backupMigrationCount: 2, appMigrationCount: 2 });
      mockApi.confirmRestore.mockResolvedValue({ ok: true });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/restore from backup/i)).toBeInTheDocument();
      });

      const file = new File(['fake-zip'], 'backup.zip', { type: 'application/zip' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, file);

      await waitFor(() => {
        expect(screen.getByText(/restore now/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/restore now/i));

      await waitFor(() => {
        expect(mockApi.confirmRestore).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.queryByText(/confirm restore/i)).not.toBeInTheDocument();
      });
    });

    it('cancel in confirmation modal aborts restore', async () => {
      mockApi.getBackups.mockResolvedValue([]);
      mockApi.uploadRestore.mockResolvedValue({ valid: true, backupMigrationCount: 2, appMigrationCount: 2 });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(/restore from backup/i)).toBeInTheDocument();
      });

      const file = new File(['fake-zip'], 'backup.zip', { type: 'application/zip' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, file);

      await waitFor(() => {
        expect(screen.getByText(/confirm restore/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/cancel/i));

      await waitFor(() => {
        expect(screen.queryByText(/confirm restore/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('direct server restore flow', () => {
    const backupEntry = {
      filename: 'narratorr-backup-20260101T000000000Z.zip',
      timestamp: '2026-01-01T00:00:00Z',
      size: 102400,
    };

    it('clicking restore button calls restoreBackupDirect API with filename and opens confirmation modal on success', async () => {
      mockApi.getBackups.mockResolvedValue([backupEntry]);
      mockApi.restoreBackupDirect.mockResolvedValue({ valid: true, backupMigrationCount: 2, appMigrationCount: 3 });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(backupEntry.filename)).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Restore backup'));

      await waitFor(() => {
        expect(mockApi.restoreBackupDirect).toHaveBeenCalledWith(backupEntry.filename);
      });

      await waitFor(() => {
        expect(screen.getByText(/confirm restore/i)).toBeInTheDocument();
      });

      // Modal shows migration counts
      expect(screen.getByText(/2 migrations/i)).toBeInTheDocument();
    });

    it('shows error toast when restoreBackupDirect API returns error (invalid backup)', async () => {
      mockApi.getBackups.mockResolvedValue([backupEntry]);
      mockApi.restoreBackupDirect.mockRejectedValue(new Error('Zip does not contain narratorr.db'));

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(backupEntry.filename)).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Restore backup'));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Zip does not contain narratorr.db');
      });

      // Modal should NOT open
      expect(screen.queryByText(/confirm restore/i)).not.toBeInTheDocument();
    });

    it('confirm in modal after server restore calls confirmRestore (shared path)', async () => {
      mockApi.getBackups.mockResolvedValue([backupEntry]);
      mockApi.restoreBackupDirect.mockResolvedValue({ valid: true, backupMigrationCount: 2, appMigrationCount: 3 });
      mockApi.confirmRestore.mockResolvedValue({ message: 'ok' });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText(backupEntry.filename)).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Restore backup'));

      await waitFor(() => {
        expect(screen.getByText(/restore now/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/restore now/i));

      await waitFor(() => {
        expect(mockApi.confirmRestore).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.queryByText(/confirm restore/i)).not.toBeInTheDocument();
      });
    });

    it('clicking a second backup while first is validating replaces the pending selection', async () => {
      const secondBackup = {
        filename: 'narratorr-backup-20260102T000000000Z.zip',
        timestamp: '2026-01-02T00:00:00Z',
        size: 204800,
      };
      let resolveFirst!: (value: unknown) => void;
      const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
      mockApi.getBackups.mockResolvedValue([backupEntry, secondBackup]);
      mockApi.restoreBackupDirect.mockReturnValueOnce(firstPromise);
      mockApi.restoreBackupDirect.mockResolvedValueOnce({ valid: true, backupMigrationCount: 5, appMigrationCount: 6 });

      const user = userEvent.setup();
      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getAllByTitle('Restore backup')).toHaveLength(2);
      });

      // Click first backup's restore
      await user.click(screen.getAllByTitle('Restore backup')[0]);
      expect(mockApi.restoreBackupDirect).toHaveBeenCalledWith(backupEntry.filename);

      // Click second backup's restore while first is still pending
      await user.click(screen.getAllByTitle('Restore backup')[1]);
      expect(mockApi.restoreBackupDirect).toHaveBeenCalledWith(secondBackup.filename);

      // Second resolves immediately — modal opens with second backup's migration counts
      await waitFor(() => {
        expect(screen.getByText(/confirm restore/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/5 migrations/i)).toBeInTheDocument();

      // Clean up first promise
      resolveFirst({ valid: true, backupMigrationCount: 2, appMigrationCount: 3 });
    });
  });

  describe('page-level section wiring', () => {
    it('renders Health Checks, Backup & Restore, System Information, and Scheduled Tasks sections together', async () => {
      mockApi.getBackups.mockResolvedValue([]);

      renderWithProviders(<SystemSettings />);

      await waitFor(() => {
        expect(screen.getByText('Health Checks')).toBeInTheDocument();
        expect(screen.getByText('Backup & Restore')).toBeInTheDocument();
        expect(screen.getByText('System Information')).toBeInTheDocument();
        expect(screen.getByText('Scheduled Tasks')).toBeInTheDocument();
      });
    });
  });
});

describe('GeneralSettingsForm (housekeeping and logging)', () => {
  it('renders housekeeping retention and log level fields on System tab', async () => {
    mockApi.getSettings.mockResolvedValue({
      system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
      general: { logLevel: 'info', housekeepingRetentionDays: 30 },
    });
    mockApi.getBackups.mockResolvedValue([]);

    renderWithProviders(<SystemSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Event History Retention (days)')).toBeInTheDocument();
      expect(screen.getByLabelText('Log Level')).toBeInTheDocument();
    });
  });

  it('submits general settings with correct payload when log level changed', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue({
      system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
      general: { logLevel: 'warn', housekeepingRetentionDays: 30 },
    });
    mockApi.getBackups.mockResolvedValue([]);
    mockApi.updateSettings.mockResolvedValue({});

    renderWithProviders(<SystemSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText('Log Level'), 'debug');
    fireEvent.submit(screen.getByLabelText('Log Level').closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        general: { logLevel: 'debug', housekeepingRetentionDays: 30 },
      });
    });
  });

  it('shows error toast when general settings save fails', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue({
      system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
      general: { logLevel: 'warn', housekeepingRetentionDays: 30 },
    });
    mockApi.getBackups.mockResolvedValue([]);
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));

    renderWithProviders(<SystemSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText('Log Level'), 'debug');
    fireEvent.submit(screen.getByLabelText('Log Level').closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });
});
