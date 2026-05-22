import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('renders a long description in full with no Show more/Show less toggle', () => {
    const longDesc = 'A'.repeat(5000);
    render(<BookDescription description={longDesc} />);

    expect(screen.getByText(longDesc)).toBeInTheDocument();
    expect(screen.queryByText('Show more')).toBeNull();
    expect(screen.queryByText('Show less')).toBeNull();
  });

  it('sanitizes HTML content via DOMPurify', () => {
    render(<BookDescription description='<p>Safe content</p><script>alert("xss")</script>' />);
    expect(screen.getByText('Safe content')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});
