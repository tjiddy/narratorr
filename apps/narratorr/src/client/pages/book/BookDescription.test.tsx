import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookDescription } from './BookDescription';

describe('BookDescription', () => {
  it('renders About This Book header', () => {
    render(<BookDescription description="A short description" />);
    expect(screen.getByText('About This Book')).toBeInTheDocument();
  });

  it('renders description content', () => {
    render(<BookDescription description="<p>An epic fantasy novel.</p>" />);
    expect(screen.getByText('An epic fantasy novel.')).toBeInTheDocument();
  });

  it('shows Show more button for long descriptions', () => {
    const longDesc = 'A'.repeat(301);
    render(<BookDescription description={longDesc} />);
    expect(screen.getByText('Show more')).toBeInTheDocument();
  });

  it('does not show button for short descriptions', () => {
    const shortDesc = 'A'.repeat(300);
    render(<BookDescription description={shortDesc} />);
    expect(screen.queryByText('Show more')).not.toBeInTheDocument();
    expect(screen.queryByText('Show less')).not.toBeInTheDocument();
  });

  it('expands description on Show more click', async () => {
    const user = userEvent.setup();
    const longDesc = 'A'.repeat(301);
    render(<BookDescription description={longDesc} />);

    await user.click(screen.getByText('Show more'));
    expect(screen.getByText('Show less')).toBeInTheDocument();
  });

  it('collapses description on Show less click', async () => {
    const user = userEvent.setup();
    const longDesc = 'A'.repeat(301);
    render(<BookDescription description={longDesc} />);

    await user.click(screen.getByText('Show more'));
    await user.click(screen.getByText('Show less'));
    expect(screen.getByText('Show more')).toBeInTheDocument();
  });

  it('sanitizes HTML content via DOMPurify', () => {
    render(<BookDescription description='<p>Safe content</p><script>alert("xss")</script>' />);
    expect(screen.getByText('Safe content')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});
