import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchAuthorCard } from './SearchAuthorCard';
import { createMockAuthorMetadata } from '@/__tests__/factories';

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
  },
}));

import { toast } from 'sonner';

describe('SearchAuthorCard', () => {
  it('renders author name', () => {
    render(<SearchAuthorCard author={createMockAuthorMetadata()} index={0} />);
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
  });

  it('renders author image when imageUrl is provided', () => {
    render(<SearchAuthorCard author={createMockAuthorMetadata()} index={0} />);
    expect(screen.getByAltText('Brandon Sanderson')).toBeInTheDocument();
  });

  it('renders fallback icon when no imageUrl', () => {
    render(<SearchAuthorCard author={createMockAuthorMetadata({ imageUrl: undefined })} index={0} />);
    expect(screen.queryByAltText('Brandon Sanderson')).not.toBeInTheDocument();
  });

  it('renders genre list', () => {
    render(<SearchAuthorCard author={createMockAuthorMetadata()} index={0} />);
    expect(screen.getByText('Fantasy, Science Fiction')).toBeInTheDocument();
  });

  it('does not render genres when none provided', () => {
    render(<SearchAuthorCard author={createMockAuthorMetadata({ genres: [] })} index={0} />);
    expect(screen.queryByText('Fantasy, Science Fiction')).not.toBeInTheDocument();
  });

  it('shows View button when author has ASIN', () => {
    render(<SearchAuthorCard author={createMockAuthorMetadata()} index={0} />);
    expect(screen.getByText('View')).toBeInTheDocument();
  });

  it('hides View button when author has no ASIN', () => {
    render(<SearchAuthorCard author={createMockAuthorMetadata({ asin: undefined })} index={0} />);
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  it('shows toast on View button click', async () => {
    const user = userEvent.setup();
    render(<SearchAuthorCard author={createMockAuthorMetadata()} index={0} />);

    await user.click(screen.getByText('View'));
    expect(toast.info).toHaveBeenCalledWith('Author pages coming soon!');
  });
});
