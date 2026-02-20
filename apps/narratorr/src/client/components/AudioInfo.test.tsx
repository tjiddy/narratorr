import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioInfo } from './AudioInfo';
import type { BookWithAuthor } from '@/lib/api';

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 1,
    title: 'Test Book',
    status: 'imported',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  };
}

describe('AudioInfo', () => {
  it('renders nothing when audioCodec is null', () => {
    const { container } = render(<AudioInfo book={makeBook()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when audioCodec is undefined', () => {
    const { container } = render(<AudioInfo book={makeBook({ audioCodec: undefined })} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders audio quality section when audioCodec is present', () => {
    render(<AudioInfo book={makeBook({
      audioCodec: 'MPEG 1 Layer 3',
      audioBitrate: 128000,
      audioSampleRate: 44100,
      audioChannels: 2,
      audioBitrateMode: 'cbr',
      audioFileFormat: 'mp3',
      audioFileCount: 12,
      audioTotalSize: 500_000_000,
      audioDuration: 36000,
    })} />);

    expect(screen.getByText('Audio Quality')).toBeInTheDocument();
  });

  it('displays codec and bitrate info', () => {
    render(<AudioInfo book={makeBook({
      audioCodec: 'AAC',
      audioBitrate: 256000,
      audioSampleRate: 44100,
      audioChannels: 2,
      audioBitrateMode: 'vbr',
    })} />);

    expect(screen.getByText(/AAC/)).toBeInTheDocument();
    expect(screen.getByText(/256 kbps/)).toBeInTheDocument();
    expect(screen.getByText(/VBR/)).toBeInTheDocument();
  });

  it('displays file count and size', () => {
    render(<AudioInfo book={makeBook({
      audioCodec: 'MPEG 1 Layer 3',
      audioFileCount: 47,
      audioTotalSize: 5_500_000_000,
      audioDuration: 72840,
    })} />);

    expect(screen.getByText(/47 files/)).toBeInTheDocument();
  });

  it('shows Mono for single channel', () => {
    render(<AudioInfo book={makeBook({
      audioCodec: 'AAC',
      audioChannels: 1,
    })} />);

    expect(screen.getByText(/Mono/)).toBeInTheDocument();
  });

  it('shows Stereo for two channels', () => {
    render(<AudioInfo book={makeBook({
      audioCodec: 'AAC',
      audioChannels: 2,
    })} />);

    expect(screen.getByText(/Stereo/)).toBeInTheDocument();
  });

  it('shows singular "file" for single file', () => {
    render(<AudioInfo book={makeBook({
      audioCodec: 'AAC',
      audioFileCount: 1,
    })} />);

    expect(screen.getByText(/1 file(?!s)/)).toBeInTheDocument();
  });

  describe('compact mode', () => {
    it('renders heading and content in compact mode', () => {
      render(<AudioInfo book={makeBook({
        audioCodec: 'AAC',
        audioBitrate: 128000,
        audioChannels: 2,
      })} compact />);

      expect(screen.getByText('Audio Quality')).toBeInTheDocument();
      expect(screen.getByText(/AAC/)).toBeInTheDocument();
    });

    it('renders nothing in compact mode when no audioCodec', () => {
      const { container } = render(<AudioInfo book={makeBook()} compact />);
      expect(container.innerHTML).toBe('');
    });
  });
});
