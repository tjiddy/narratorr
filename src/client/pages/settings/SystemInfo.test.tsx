import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/helpers';
import { SystemInfo } from './SystemInfo';

vi.mock('@/lib/api', () => ({
  api: {
    getSystemInfo: vi.fn(),
  },
  formatBytes: (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  },
}));

import { api } from '@/lib/api';
import type { Mock } from 'vitest';

describe('SystemInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays version, Node version, OS info', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({
      version: '0.1.0',
      nodeVersion: 'v20.11.1',
      os: 'Linux 6.1.0',
      dbSize: 1048576,
      libraryPath: '/audiobooks',
      freeSpace: 107374182400,
    });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('0.1.0')).toBeInTheDocument();
    });
    expect(screen.getByText('v20.11.1')).toBeInTheDocument();
    expect(screen.getByText('Linux 6.1.0')).toBeInTheDocument();
  });

  it('displays DB size in human-readable format', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({
      version: '0.1.0',
      nodeVersion: 'v20.11.1',
      os: 'Linux 6.1.0',
      dbSize: 1048576,
      libraryPath: '/audiobooks',
      freeSpace: 107374182400,
    });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('1 MB')).toBeInTheDocument();
    });
  });

  it('displays library path and free space', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({
      version: '0.1.0',
      nodeVersion: 'v20.11.1',
      os: 'Linux 6.1.0',
      dbSize: 1048576,
      libraryPath: '/audiobooks',
      freeSpace: 107374182400,
    });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('/audiobooks')).toBeInTheDocument();
    });
    expect(screen.getByText('100 GB')).toBeInTheDocument();
  });

  it('handles missing/null values gracefully', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({
      version: '0.1.0',
      nodeVersion: 'v20.11.1',
      os: 'Linux 6.1.0',
      dbSize: null,
      libraryPath: null,
      freeSpace: null,
    });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('0.1.0')).toBeInTheDocument();
    });
    // Should show N/A or similar for null values
    const naElements = screen.getAllByText(/n\/a|not configured/i);
    expect(naElements.length).toBeGreaterThanOrEqual(1);
  });
});
