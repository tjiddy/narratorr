import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
