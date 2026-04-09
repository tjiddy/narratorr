import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventReasonDetails } from './eventReasonFormatters';

describe('EventReasonDetails', () => {
  const emptyMap = new Map<number, string>();

  it('renders grabbed details with key-value pairs', () => {
    render(<EventReasonDetails eventType="grabbed" reason={{ indexerId: 1, size: 1024, protocol: 'torrent' }} indexerMap={emptyMap} />);
    expect(screen.getByText('Indexer:')).toBeInTheDocument();
    expect(screen.getByText('Protocol:')).toBeInTheDocument();
    expect(screen.getByText('Size:')).toBeInTheDocument();
  });

  it('renders imported auto details with path, file count, and size', () => {
    render(<EventReasonDetails eventType="imported" reason={{ targetPath: '/lib/Author/Book', fileCount: 5, totalSize: 1048576 }} indexerMap={emptyMap} />);
    expect(screen.getByText('/lib/Author/Book')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('1 MB')).toBeInTheDocument();
  });

  it('renders imported manual details with path and mode', () => {
    render(<EventReasonDetails eventType="imported" reason={{ targetPath: '/lib/Author/Book', mode: 'copy' }} indexerMap={emptyMap} />);
    expect(screen.getByText('/lib/Author/Book')).toBeInTheDocument();
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('renders error details with icon and message text', () => {
    render(<EventReasonDetails eventType="import_failed" reason={{ error: 'disk full' }} indexerMap={emptyMap} />);
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('renders error details as generic fallback when no error field', () => {
    render(<EventReasonDetails eventType="import_failed" reason={{ code: 42, msg: 'oops' }} indexerMap={emptyMap} />);
    expect(screen.getByText('Code:')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders download_completed with progress', () => {
    render(<EventReasonDetails eventType="download_completed" reason={{ progress: 1 }} indexerMap={emptyMap} />);
    expect(screen.getByText('Progress:')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders generic fallback for unknown event types', () => {
    render(<EventReasonDetails eventType="some_future" reason={{ alpha: 'beta', count: 7 }} indexerMap={emptyMap} />);
    expect(screen.getByText('Alpha:')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText('Count:')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('omits null values in generic fallback', () => {
    render(<EventReasonDetails eventType="unknown" reason={{ visible: 'yes', hidden: null }} indexerMap={emptyMap} />);
    expect(screen.getByText('Visible:')).toBeInTheDocument();
    expect(screen.queryByText('Hidden:')).not.toBeInTheDocument();
  });

  it('renders upgraded events with imported-style labels and formatted size', () => {
    render(<EventReasonDetails eventType="upgraded" reason={{ targetPath: '/lib/Author/Upgraded', fileCount: 8, totalSize: 2097152 }} indexerMap={emptyMap} />);
    expect(screen.getByText('Path:')).toBeInTheDocument();
    expect(screen.getByText('/lib/Author/Upgraded')).toBeInTheDocument();
    expect(screen.getByText('Files:')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('Size:')).toBeInTheDocument();
    expect(screen.getByText('2 MB')).toBeInTheDocument();
    // Must NOT fall through to generic labels like "Target Path:"
    expect(screen.queryByText('Target Path:')).not.toBeInTheDocument();
  });

  it('renders download_failed with error text via error renderer', () => {
    render(<EventReasonDetails eventType="download_failed" reason={{ error: 'connection timeout' }} indexerMap={emptyMap} />);
    expect(screen.getByText('connection timeout')).toBeInTheDocument();
    // Must render as plain text error, not as a generic "Error:" key-value row
    expect(screen.queryByText('Error:')).not.toBeInTheDocument();
  });
});
