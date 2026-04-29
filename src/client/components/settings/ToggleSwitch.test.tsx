import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { ToggleSwitch } from './ToggleSwitch';

function RHFWrapper({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { register, formState: { isDirty } } = useForm({ defaultValues: { enabled: false } });
  onDirtyChange?.(isDirty);
  return (
    <label>
      Toggle
      <ToggleSwitch {...register('enabled')} />
    </label>
  );
}

describe('ToggleSwitch', () => {
  describe('rendering', () => {
    it('renders a hidden checkbox input with sr-only class and a styled div sibling with rounded-full', () => {
      render(
        <label>
          Test
          <ToggleSwitch id="test" />
        </label>
      );
      const input = screen.getByRole('checkbox');
      expect(input).toHaveClass('sr-only');
      expect(input.tagName).toBe('INPUT');
      expect(input).toHaveAttribute('type', 'checkbox');

      const sibling = input.nextElementSibling;
      expect(sibling).not.toBeNull();
      expect(sibling!.tagName).toBe('DIV');
      expect(sibling).toHaveClass('rounded-full');
    });

    it('renders full size variant by default', () => {
      render(
        <label>
          Test
          <ToggleSwitch id="test" />
        </label>
      );
      const sibling = screen.getByRole('checkbox').nextElementSibling!;
      expect(sibling).toHaveClass('w-11', 'h-6');
    });

    it('renders compact size variant when size="compact"', () => {
      render(
        <label>
          Test
          <ToggleSwitch id="test" size="compact" />
        </label>
      );
      const sibling = screen.getByRole('checkbox').nextElementSibling!;
      expect(sibling).toHaveClass('w-9', 'h-5');
    });

    it('passes through id, name, aria-label attributes to the input element', () => {
      render(
        <label>
          Test
          <ToggleSwitch id="my-toggle" name="myField" aria-label="My Toggle" />
        </label>
      );
      const input = screen.getByRole('checkbox');
      expect(input).toHaveAttribute('id', 'my-toggle');
      expect(input).toHaveAttribute('name', 'myField');
      expect(input).toHaveAttribute('aria-label', 'My Toggle');
    });
  });

  describe('interaction', () => {
    it('toggling fires onChange via userEvent.click', async () => {
      const onChange = vi.fn();
      render(
        <label>
          Test
          <ToggleSwitch id="test" onChange={onChange} />
        </label>
      );
      const input = screen.getByRole('checkbox');
      await userEvent.click(input);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(input).toBeChecked();
    });

    it('disabled state: input is disabled, click does not fire onChange', async () => {
      const onChange = vi.fn();
      render(
        <label>
          Test
          <ToggleSwitch id="test" disabled onChange={onChange} />
        </label>
      );
      const input = screen.getByRole('checkbox');
      expect(input).toBeDisabled();
      await userEvent.click(input);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('RHF integration', () => {
    it('register() spread attaches ref and onChange correctly', async () => {
      render(<RHFWrapper />);
      const input = screen.getByRole('checkbox');
      expect(input).not.toBeChecked();
      await userEvent.click(input);
      expect(input).toBeChecked();
    });

    it('form dirty state updates when toggled', async () => {
      const dirtyStates: boolean[] = [];
      const { rerender } = render(<RHFWrapper onDirtyChange={(d) => dirtyStates.push(d)} />);
      expect(dirtyStates[dirtyStates.length - 1]).toBe(false);

      await userEvent.click(screen.getByRole('checkbox'));
      rerender(<RHFWrapper onDirtyChange={(d) => dirtyStates.push(d)} />);
      expect(dirtyStates[dirtyStates.length - 1]).toBe(true);
    });
  });

  describe('boundary values', () => {
    it('renders without error when only type is provided via component default', () => {
      render(
        <label>
          Test
          <ToggleSwitch />
        </label>
      );
      expect(screen.getByRole('checkbox')).toBeInTheDocument();
    });

    it('checkbox is not checked when defaultChecked is false', () => {
      render(
        <label>
          Test
          <ToggleSwitch defaultChecked={false} />
        </label>
      );
      expect(screen.getByRole('checkbox')).not.toBeChecked();
    });

    it('checkbox is checked when defaultChecked is true', () => {
      render(
        <label>
          Test
          <ToggleSwitch defaultChecked />
        </label>
      );
      expect(screen.getByRole('checkbox')).toBeChecked();
    });
  });
});
