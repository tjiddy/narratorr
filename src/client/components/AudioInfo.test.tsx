import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioInfo } from './AudioInfo';
import { createMockBook } from '@/__tests__/factories';
import type { BookWithAuthor } from '@/lib/api';

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return createMockBook({ status: 'imported', ...overrides });
}

describe('AudioInfo', () => {
  it('renders nothing when audioCodec is null', () => {
    const { container } = render(<AudioInfo book={makeBook()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when audioCodec is undefined', () => {
    const { container } = render(<AudioInfo book={makeBook({ audioCodec: undefined })} />);
    expect(container).toBeEmptyDOMElement();
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

  describe('quality tier display', () => {
    it('displays MB/hr and quality tier when audioTotalSize and audioDuration are present', () => {
      render(<AudioInfo book={makeBook({
        audioCodec: 'AAC',
        audioTotalSize: 500 * 1024 * 1024, // 500 MB
        audioDuration: 36000, // 10 hours → 50 MB/hr → Fair
      })} />);

      expect(screen.getByText('Fair')).toBeInTheDocument();
      expect(screen.getByText('50 MB/hr')).toBeInTheDocument();
    });

    it('uses size fallback when audioTotalSize is null', () => {
      render(<AudioInfo book={makeBook({
        audioCodec: 'AAC',
        audioTotalSize: null,
        size: 500 * 1024 * 1024,
        audioDuration: 36000,
      })} />);

      expect(screen.getByText('Fair')).toBeInTheDocument();
      expect(screen.getByText('50 MB/hr')).toBeInTheDocument();
    });

    it('uses duration fallback when audioDuration is null', () => {
      render(<AudioInfo book={makeBook({
        audioCodec: 'AAC',
        audioTotalSize: 500 * 1024 * 1024,
        audioDuration: null,
        duration: 600, // 600 minutes = 36000 seconds → 50 MB/hr
      })} />);

      expect(screen.getByText('Fair')).toBeInTheDocument();
      expect(screen.getByText('50 MB/hr')).toBeInTheDocument();
    });

    it('does not display quality when size is not resolvable', () => {
      render(<AudioInfo book={makeBook({
        audioCodec: 'AAC',
        audioTotalSize: null,
        size: null,
        audioDuration: 36000,
      })} />);

      expect(screen.queryByText(/MB\/hr/)).not.toBeInTheDocument();
    });

    it('does not display quality when duration is not resolvable', () => {
      render(<AudioInfo book={makeBook({
        audioCodec: 'AAC',
        audioTotalSize: 500 * 1024 * 1024,
        audioDuration: null,
        duration: null,
      })} />);

      expect(screen.queryByText(/MB\/hr/)).not.toBeInTheDocument();
    });

    it('shows correct tier label matching calculateQuality output', () => {
      // 300 MB over 1 hour = 300 MB/hr → High tier
      render(<AudioInfo book={makeBook({
        audioCodec: 'AAC',
        audioTotalSize: 300 * 1024 * 1024,
        audioDuration: 3600,
      })} />);

      expect(screen.getByText('High')).toBeInTheDocument();
      expect(screen.getByText('300 MB/hr')).toBeInTheDocument();
    });
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
      expect(container).toBeEmptyDOMElement();
    });
  });
});
