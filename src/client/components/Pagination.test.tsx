import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { Pagination } from './Pagination';

describe('Pagination', () => {
  describe('rendering', () => {
    it('shows "Showing X-Y of Z" text', () => {
      renderWithProviders(
        <Pagination page={1} totalPages={5} total={50} limit={10} onPageChange={vi.fn()} />,
      );
      // Text is split across child elements, use custom matcher
      expect(screen.getByText((_content, element) =>
        element?.tagName === 'P' && element.textContent === 'Showing 1–10 of 50',
      )).toBeInTheDocument();
    });

    it('hides controls when total=0', () => {
      const { container } = renderWithProviders(
        <Pagination page={1} totalPages={1} total={0} limit={10} onPageChange={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('hides controls when total <= limit (single page)', () => {
      const { container } = renderWithProviders(
        <Pagination page={1} totalPages={1} total={5} limit={10} onPageChange={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('shows page 1 of N', () => {
      renderWithProviders(
        <Pagination page={1} totalPages={3} total={30} limit={10} onPageChange={vi.fn()} />,
      );
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });

    it('shows correct range on middle page', () => {
      renderWithProviders(
        <Pagination page={2} totalPages={5} total={50} limit={10} onPageChange={vi.fn()} />,
      );
      expect(screen.getByText((_content, element) =>
        element?.tagName === 'P' && element.textContent === 'Showing 11–20 of 50',
      )).toBeInTheDocument();
    });

    it('shows correct range on last page with partial results', () => {
      renderWithProviders(
        <Pagination page={3} totalPages={3} total={25} limit={10} onPageChange={vi.fn()} />,
      );
      expect(screen.getByText((_content, element) =>
        element?.tagName === 'P' && element.textContent === 'Showing 21–25 of 25',
      )).toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('calls onPageChange with next page when clicking next', async () => {
      const user = userEvent.setup();
      const onPageChange = vi.fn();
      renderWithProviders(
        <Pagination page={1} totalPages={3} total={30} limit={10} onPageChange={onPageChange} />,
      );

      await user.click(screen.getByRole('button', { name: /next/i }));
      expect(onPageChange).toHaveBeenCalledWith(2);
    });

    it('calls onPageChange with previous page when clicking previous', async () => {
      const user = userEvent.setup();
      const onPageChange = vi.fn();
      renderWithProviders(
        <Pagination page={2} totalPages={3} total={30} limit={10} onPageChange={onPageChange} />,
      );

      await user.click(screen.getByRole('button', { name: /previous/i }));
      expect(onPageChange).toHaveBeenCalledWith(1);
    });

    it('disables previous button on first page', () => {
      renderWithProviders(
        <Pagination page={1} totalPages={3} total={30} limit={10} onPageChange={vi.fn()} />,
      );
      expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    });

    it('disables next button on last page', () => {
      renderWithProviders(
        <Pagination page={3} totalPages={3} total={30} limit={10} onPageChange={vi.fn()} />,
      );
      expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    });
  });
});
