import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/helpers';
import { SystemInfo } from './SystemInfo';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      getSystemInfo: vi.fn(),
    },
  };
});

import { api } from '@/lib/api';
import type { Mock } from 'vitest';

const baseInfo = {
  version: '0.1.0',
  commit: '4445dd4',
  buildTime: '2026-03-29T11:29:40Z',
  nodeVersion: 'v20.11.1',
  os: 'Linux 6.1.0',
  dbSize: 1048576,
  libraryPath: '/audiobooks',
  freeSpace: 107374182400,
};

describe('SystemInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays version, Node version, OS info', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue(baseInfo);

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
    });
    expect(screen.getByText('v20.11.1')).toBeInTheDocument();
    expect(screen.getByText('Linux 6.1.0')).toBeInTheDocument();
  });

  it('displays DB size in human-readable format', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue(baseInfo);

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('1 MB')).toBeInTheDocument();
    });
  });

  it('displays library path and free space', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue(baseInfo);

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('/audiobooks')).toBeInTheDocument();
    });
    expect(screen.getByText('100 GB')).toBeInTheDocument();
  });

  it('displays commit SHA inline with version when commit is a real SHA', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({ ...baseInfo, commit: '4445dd4' });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('0.1.0 (4445dd4)')).toBeInTheDocument();
    });
  });

  it('displays build timestamp when buildTime is a valid ISO string', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue(baseInfo);

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('Built')).toBeInTheDocument();
    });
  });

  it('hides build timestamp when buildTime is "unknown"', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({ ...baseInfo, buildTime: 'unknown' });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
    });
    expect(screen.queryByText('Built')).not.toBeInTheDocument();
  });

  it('hides build timestamp when buildTime is absent', async () => {
    const { buildTime: _, ...infoWithoutBuildTime } = baseInfo;
    (api.getSystemInfo as Mock).mockResolvedValue(infoWithoutBuildTime);

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
    });
    expect(screen.queryByText('Built')).not.toBeInTheDocument();
  });

  it('suppresses commit display when commit is "unknown"', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({ ...baseInfo, commit: 'unknown' });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText('0.1.0')).toBeInTheDocument();
    });
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
  });

  it('handles missing/null values gracefully', async () => {
    (api.getSystemInfo as Mock).mockResolvedValue({
      ...baseInfo,
      dbSize: null,
      libraryPath: null,
      freeSpace: null,
    });

    renderWithProviders(<SystemInfo />);

    await waitFor(() => {
      expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
    });
    // Should show N/A or similar for null values
    const naElements = screen.getAllByText(/n\/a|not configured/i);
    expect(naElements.length).toBeGreaterThanOrEqual(1);
  });
});
