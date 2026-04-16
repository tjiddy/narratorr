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

  describe('variant prop (#288)', () => {
    it('default variant renders with settings-form classes', () => {
      render(
        <SelectWithChevron id="test" variant="default" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('w-full');
      expect(select).toHaveClass('px-4');
      expect(select).toHaveClass('py-3');
      expect(select).toHaveClass('pr-10');
      expect(select).toHaveClass('bg-background');
      expect(select).toHaveClass('border');
      expect(select).toHaveClass('rounded-xl');
      expect(select).toHaveClass('text-sm');
    });

    it('default variant chevron uses w-4 h-4', () => {
      render(
        <SelectWithChevron id="test" variant="default" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const svg = screen.getByLabelText('Test').parentElement!.querySelector('svg');
      expect(svg).toHaveClass('w-4');
      expect(svg).toHaveClass('h-4');
    });

    it('compact variant renders with compact base classes and no w-full', () => {
      render(
        <SelectWithChevron id="test" variant="compact" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('glass-card');
      expect(select).toHaveClass('rounded-lg');
      expect(select).toHaveClass('pl-3');
      expect(select).toHaveClass('pr-7');
      expect(select).toHaveClass('font-medium');
      expect(select).toHaveClass('text-foreground');
      expect(select).not.toHaveClass('w-full');
      expect(select).not.toHaveClass('bg-background');
      expect(select).not.toHaveClass('border');
      expect(select).not.toHaveClass('rounded-xl');
    });

    it('compact variant chevron uses w-3 h-3 and right-2 positioning', () => {
      render(
        <SelectWithChevron id="test" variant="compact" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const svg = screen.getByLabelText('Test').parentElement!.querySelector('svg');
      expect(svg).toHaveClass('w-3');
      expect(svg).toHaveClass('h-3');
      expect(svg).toHaveClass('right-2');
    });

    it('default variant chevron uses right-3 positioning', () => {
      render(
        <SelectWithChevron id="test" variant="default" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const svg = screen.getByLabelText('Test').parentElement!.querySelector('svg');
      expect(svg).toHaveClass('right-3');
    });

    it('variant defaults to default when omitted — no class change for existing callers', () => {
      render(
        <SelectWithChevron id="test" label="Test">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('w-full');
      expect(select).toHaveClass('rounded-xl');
      expect(select).toHaveClass('bg-background');
    });

    it('className prop appends correctly in compact variant', () => {
      render(
        <SelectWithChevron id="test" variant="compact" label="Test" className="py-1.5 text-xs">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('glass-card');
      expect(select).toHaveClass('py-1.5');
      expect(select).toHaveClass('text-xs');
    });

    it('error prop applies border-destructive in default variant', () => {
      render(
        <SelectWithChevron id="test" variant="default" label="Test" error>
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const select = screen.getByLabelText('Test');
      expect(select).toHaveClass('border-destructive');
    });

    it('label prop renders label element in compact variant', () => {
      render(
        <SelectWithChevron id="test" variant="compact" label="Compact Label">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      expect(screen.getByText('Compact Label').tagName).toBe('LABEL');
    });

    it('default variant label uses text-sm font-medium mb-2 classes', () => {
      render(
        <SelectWithChevron id="test" variant="default" label="Default Label">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const label = screen.getByText('Default Label');
      expect(label).toHaveClass('text-sm');
      expect(label).toHaveClass('font-medium');
      expect(label).toHaveClass('mb-2');
    });

    it('default variant label does not have text-xs text-muted-foreground mb-1 classes', () => {
      render(
        <SelectWithChevron id="test" variant="default" label="Default Label">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const label = screen.getByText('Default Label');
      expect(label).not.toHaveClass('text-xs');
      expect(label).not.toHaveClass('text-muted-foreground');
      expect(label).not.toHaveClass('mb-1');
    });

    it('compact variant label uses text-xs font-medium text-muted-foreground mb-1 classes', () => {
      render(
        <SelectWithChevron id="test" variant="compact" label="Compact Label">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const label = screen.getByText('Compact Label');
      expect(label).toHaveClass('text-xs');
      expect(label).toHaveClass('font-medium');
      expect(label).toHaveClass('text-muted-foreground');
      expect(label).toHaveClass('mb-1');
    });

    it('compact variant label does not have text-sm or mb-2 classes', () => {
      render(
        <SelectWithChevron id="test" variant="compact" label="Compact Label">
          <option value="a">A</option>
        </SelectWithChevron>
      );
      const label = screen.getByText('Compact Label');
      expect(label).not.toHaveClass('text-sm');
      expect(label).not.toHaveClass('mb-2');
    });

    it('forwardRef works in compact variant', () => {
      const ref = { current: null as HTMLSelectElement | null };
      render(
        <SelectWithChevron id="test" variant="compact" label="Test" ref={ref}>
          <option value="a">A</option>
        </SelectWithChevron>
      );
      expect(ref.current).toBeInstanceOf(HTMLSelectElement);
    });
  });
});
