import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs, type TabItem } from '@/components/Tabs';

const tabs: TabItem[] = [
  { value: 'books', label: 'Books', icon: <span data-testid="icon-books">B</span> },
  { value: 'authors', label: 'Authors', icon: <span data-testid="icon-authors">A</span> },
];

describe('Tabs', () => {
  describe('ARIA attributes', () => {
    it('renders role="tablist" on container', () => {
      render(<Tabs tabs={tabs} value="books" onChange={() => {}} ariaLabel="Search results" />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
    });

    it('renders role="tab" on each tab button', () => {
      render(<Tabs tabs={tabs} value="books" onChange={() => {}} ariaLabel="Search results" />);
      expect(screen.getAllByRole('tab')).toHaveLength(2);
    });

    it('active tab has aria-selected="true", inactive has aria-selected="false"', () => {
      render(<Tabs tabs={tabs} value="books" onChange={() => {}} ariaLabel="Search results" />);
      const [booksTab, authorsTab] = screen.getAllByRole('tab');
      expect(booksTab).toHaveAttribute('aria-selected', 'true');
      expect(authorsTab).toHaveAttribute('aria-selected', 'false');
    });

    it('active tab has tabIndex={0}, inactive has tabIndex={-1}', () => {
      render(<Tabs tabs={tabs} value="books" onChange={() => {}} ariaLabel="Search results" />);
      const [booksTab, authorsTab] = screen.getAllByRole('tab');
      expect(booksTab).toHaveAttribute('tabindex', '0');
      expect(authorsTab).toHaveAttribute('tabindex', '-1');
    });

    it('each tab has aria-controls pointing to its panel id', () => {
      render(<Tabs tabs={tabs} value="books" onChange={() => {}} ariaLabel="Search results" />);
      const [booksTab, authorsTab] = screen.getAllByRole('tab');
      expect(booksTab).toHaveAttribute('aria-controls', 'tabpanel-books');
      expect(authorsTab).toHaveAttribute('aria-controls', 'tabpanel-authors');
    });

    it('each tab has a matching id for aria-labelledby on panels', () => {
      render(<Tabs tabs={tabs} value="books" onChange={() => {}} ariaLabel="Search results" />);
      const [booksTab, authorsTab] = screen.getAllByRole('tab');
      expect(booksTab).toHaveAttribute('id', 'tab-books');
      expect(authorsTab).toHaveAttribute('id', 'tab-authors');
    });

    it('renders tablist with correct aria-label', () => {
      render(<Tabs tabs={tabs} value="books" onChange={() => {}} ariaLabel="Search results" />);
      expect(screen.getByRole('tablist')).toHaveAttribute('aria-label', 'Search results');
    });
  });

  describe('interaction', () => {
    it('clicking a tab calls onChange with the correct tab value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Tabs tabs={tabs} value="books" onChange={onChange} ariaLabel="Test" />);
      await user.click(screen.getByRole('tab', { name: /authors/i }));
      expect(onChange).toHaveBeenCalledWith('authors');
    });

    it('does not call onChange when clicking the already-active tab', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Tabs tabs={tabs} value="books" onChange={onChange} ariaLabel="Test" />);
      await user.click(screen.getByRole('tab', { name: /books/i }));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('keyboard navigation', () => {
    it('ArrowRight moves focus to next tab', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Tabs tabs={tabs} value="books" onChange={onChange} ariaLabel="Test" />);
      const booksTab = screen.getByRole('tab', { name: /books/i });
      booksTab.focus();
      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenCalledWith('authors');
    });

    it('ArrowRight wraps to first tab from last', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Tabs tabs={tabs} value="authors" onChange={onChange} ariaLabel="Test" />);
      const authorsTab = screen.getByRole('tab', { name: /authors/i });
      authorsTab.focus();
      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenCalledWith('books');
    });

    it('ArrowLeft moves focus to previous tab', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Tabs tabs={tabs} value="authors" onChange={onChange} ariaLabel="Test" />);
      const authorsTab = screen.getByRole('tab', { name: /authors/i });
      authorsTab.focus();
      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenCalledWith('books');
    });

    it('ArrowLeft wraps to last tab from first', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Tabs tabs={tabs} value="books" onChange={onChange} ariaLabel="Test" />);
      const booksTab = screen.getByRole('tab', { name: /books/i });
      booksTab.focus();
      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenCalledWith('authors');
    });

    it('non-arrow keys do not trigger onChange', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Tabs tabs={tabs} value="books" onChange={onChange} ariaLabel="Test" />);
      const booksTab = screen.getByRole('tab', { name: /books/i });
      booksTab.focus();
      await user.keyboard('{Enter}');
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('boundary values', () => {
    it('single tab renders correctly', () => {
      const singleTab: TabItem[] = [{ value: 'only', label: 'Only Tab' }];
      render(<Tabs tabs={singleTab} value="only" onChange={() => {}} ariaLabel="Single" />);
      expect(screen.getAllByRole('tab')).toHaveLength(1);
      expect(screen.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
    });

    it('three tabs wrap correctly with ArrowRight from last', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const threeTabs: TabItem[] = [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ];
      render(<Tabs tabs={threeTabs} value="c" onChange={onChange} ariaLabel="Three" />);
      const cTab = screen.getByRole('tab', { name: 'C' });
      cTab.focus();
      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenCalledWith('a');
    });

    it('renders tab labels with badges when provided', () => {
      const badgeTabs: TabItem[] = [
        { value: 'books', label: 'Books', badge: '(5)' },
        { value: 'authors', label: 'Authors' },
      ];
      render(<Tabs tabs={badgeTabs} value="books" onChange={() => {}} ariaLabel="Test" />);
      expect(screen.getByText('(5)')).toBeInTheDocument();
    });
  });
});
