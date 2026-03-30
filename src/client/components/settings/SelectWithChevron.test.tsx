import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { SelectWithChevron } from './SelectWithChevron';

function RHFWrapper() {
  const { register } = useForm({ defaultValues: { color: 'red' } });
  return (
    <SelectWithChevron id="color" label="Color" {...register('color')}>
      <option value="red">Red</option>
      <option value="blue">Blue</option>
    </SelectWithChevron>
  );
}

describe('SelectWithChevron', () => {
  describe('rendering', () => {
    it('renders a native select with appearance-none class and a ChevronDownIcon', () => {
      render(
        <SelectWithChevron id="test" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select.tagName).toBe('SELECT');
      expect(select).toHaveClass('appearance-none');
      // ChevronDownIcon renders as svg
      const svg = select.parentElement!.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('renders label when label prop is provided', () => {
      render(
        <SelectWithChevron id="test" label="My Label">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      expect(screen.getByText('My Label')).toBeInTheDocument();
      expect(screen.getByText('My Label').tagName).toBe('LABEL');
    });

    it('renders without label when label is omitted', () => {
      render(
        <SelectWithChevron id="test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByRole('combobox');
      expect(select).toBeInTheDocument();
      expect(screen.queryByRole('label')).not.toBeInTheDocument();
    });

    it('renders children as option elements inside the select', () => {
      render(
        <SelectWithChevron id="test" label="Test">
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test') as HTMLSelectElement;
      expect(select.options).toHaveLength(3);
    });

    it('applies id prop to both the select element and the label htmlFor', () => {
      render(
        <SelectWithChevron id="my-id" label="My Field">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('My Field');
      expect(select).toHaveAttribute('id', 'my-id');
    });
  });

  describe('props and styling', () => {
    it('forwards standard select HTML attributes to the native select', () => {
      render(
        <SelectWithChevron id="test" label="Test" disabled name="myField" aria-label="custom">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toBeDisabled();
      expect(select).toHaveAttribute('name', 'myField');
    });

    it('applies custom className alongside default classes', () => {
      render(
        <SelectWithChevron id="test" label="Test" className="my-custom-class">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('appearance-none');
      expect(select).toHaveClass('my-custom-class');
    });

    it('renders error state styling when error prop is true', () => {
      render(
        <SelectWithChevron id="test" label="Test" error>
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('border-destructive');
      expect(select).not.toHaveClass('border-border');
    });

    it('renders normal border when error is false', () => {
      render(
        <SelectWithChevron id="test" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('border-border');
      expect(select).not.toHaveClass('border-destructive');
    });

    it('chevron icon is pointer-events-none', () => {
      render(
        <SelectWithChevron id="test" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      const svg = select.parentElement!.querySelector('svg');
      expect(svg).toHaveClass('pointer-events-none');
    });
  });

  describe('interaction', () => {
    it('fires onChange when user selects a different option', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <SelectWithChevron id="test" label="Test" onChange={onChange}>
          <option value="a">A</option>
          <option value="b">B</option>
        </SelectWithChevron>
      );
      await user.selectOptions(screen.getByLabelText('Test'), 'b');
      expect(onChange).toHaveBeenCalled();
    });

    it('works with React Hook Form register spread including ref forwarding', () => {
      render(<RHFWrapper />);
      const select = screen.getByLabelText('Color') as HTMLSelectElement;
      expect(select.value).toBe('red');
      expect(select).toHaveAttribute('name', 'color');
    });

    it('disabled select prevents interaction', () => {
      render(
        <SelectWithChevron id="test" label="Test" disabled>
          <option value="a">A</option>
        </SelectWithChevron>
      );
      expect(screen.getByLabelText('Test')).toBeDisabled();
    });
  });

  describe('edge cases', () => {
    it('renders empty select without error when given zero options', () => {
      render(<SelectWithChevron id="test" label="Test" />);
      const select = screen.getByLabelText('Test') as HTMLSelectElement;
      expect(select.options).toHaveLength(0);
    });

    it('multiple instances on the same page do not interfere with each other', () => {
      render(
        <>
          <SelectWithChevron id="first" label="First">
            <option value="a">A</option>
          </SelectWithChevron>
          <SelectWithChevron id="second" label="Second">
            <option value="b">B</option>
          </SelectWithChevron>
        </>
      );
      expect(screen.getByLabelText('First')).toHaveAttribute('id', 'first');
      expect(screen.getByLabelText('Second')).toHaveAttribute('id', 'second');
    });
  });
});
