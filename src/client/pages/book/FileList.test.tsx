import { describe, it, expect, vi, type Mock } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { api } from '@/lib/api';
import { FileList } from './FileList';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const actualApi = (actual as { api: Record<string, unknown> }).api;
  return {
    ...actual,
    api: {
      ...actualApi,
      getBookFiles: vi.fn(),
    },
  };
});

const mockFiles = [
  { name: 'Chapter 01.m4b', size: 52428800 },
  { name: 'Chapter 02.m4b', size: 1048576 },
  { name: 'Chapter 03.m4b', size: 1536 },
];

describe('FileList', () => {
  it('renders nothing when API returns empty array', async () => {
    (api.getBookFiles as Mock).mockResolvedValue([]);

    const { container } = renderWithProviders(<FileList bookId={1} />);

    // Wait for query to settle — header should show "Files (0)"
    await screen.findByText('Files (0)');
    expect(container.querySelector('ul')).not.toBeInTheDocument();
  });

  it('shows collapsed header with file count', async () => {
    (api.getBookFiles as Mock).mockResolvedValue(mockFiles);

    renderWithProviders(<FileList bookId={1} />);

    const header = await screen.findByText('Files (3)');
    expect(header).toBeInTheDocument();
    // File names should not be visible when collapsed
    expect(screen.queryByText('Chapter 01.m4b')).not.toBeInTheDocument();
  });

  it('expands file list on header click', async () => {
    (api.getBookFiles as Mock).mockResolvedValue(mockFiles);
    const user = userEvent.setup();

    renderWithProviders(<FileList bookId={1} />);

    await user.click(await screen.findByText('Files (3)'));

    expect(screen.getByText('Chapter 01.m4b')).toBeInTheDocument();
    expect(screen.getByText('Chapter 02.m4b')).toBeInTheDocument();
    expect(screen.getByText('Chapter 03.m4b')).toBeInTheDocument();
  });

  it('collapses on second click', async () => {
    (api.getBookFiles as Mock).mockResolvedValue(mockFiles);
    const user = userEvent.setup();

    renderWithProviders(<FileList bookId={1} />);

    const header = await screen.findByText('Files (3)');
    await user.click(header);
    expect(screen.getByText('Chapter 01.m4b')).toBeInTheDocument();

    await user.click(header);
    expect(screen.queryByText('Chapter 01.m4b')).not.toBeInTheDocument();
  });

  it('formats file sizes correctly', async () => {
    (api.getBookFiles as Mock).mockResolvedValue(mockFiles);
    const user = userEvent.setup();

    renderWithProviders(<FileList bookId={1} />);

    await user.click(await screen.findByText('Files (3)'));

    // 52428800 bytes = 50 MB
    expect(screen.getByText('50 MB')).toBeInTheDocument();
    // 1048576 bytes = 1 MB
    expect(screen.getByText('1 MB')).toBeInTheDocument();
    // 1536 bytes = 1.5 KB
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
  });

  it('shows error message on API error', async () => {
    (api.getBookFiles as Mock).mockRejectedValue(new Error('Network error'));

    renderWithProviders(<FileList bookId={1} />);

    await screen.findByText(/failed to load/i);
  });

  it('shows loading indicator while data is being fetched', () => {
    (api.getBookFiles as Mock).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<FileList bookId={1} />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows empty state message when expanded with no files', async () => {
    (api.getBookFiles as Mock).mockResolvedValue([]);
    const user = userEvent.setup();

    renderWithProviders(<FileList bookId={1} />);

    await user.click(await screen.findByText('Files (0)'));

    expect(screen.getByText('No audio files found')).toBeInTheDocument();
  });
});
