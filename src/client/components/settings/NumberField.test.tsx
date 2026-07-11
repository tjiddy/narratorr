import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { NumberField } from './NumberField';

function RHFWrapper({ onSubmit }: { onSubmit: (data: { num: number }) => void }) {
  const { register, handleSubmit } = useForm({ defaultValues: { num: 5 } });
  return (
    <form onSubmit={handleSubmit((d) => onSubmit(d as { num: number }))}>
      <NumberField aria-label="Num" {...register('num', { valueAsNumber: true })} />
      <button type="submit">Save</button>
    </form>
  );
}

describe('NumberField', () => {
  it('renders a number input with the width on the wrapper div, never the input', () => {
    render(<NumberField aria-label="Bitrate" />);
    const input = screen.getByRole('spinbutton', { name: 'Bitrate' });
    expect(input).toHaveAttribute('type', 'number');
    // errorInputClass's w-full beats width utilities on the input in compiled CSS — the real
    // width must live on the wrapper (the select idiom).
    expect(input.parentElement).toHaveClass('w-24');
    expect(input).not.toHaveClass('w-24');
  });

  it('renders the unit suffix beside the input when provided, and none otherwise', () => {
    const { rerender } = render(<NumberField aria-label="Bitrate" suffix="kbps" />);
    expect(screen.getByText('kbps')).toBeInTheDocument();
    rerender(<NumberField aria-label="Bitrate" />);
    expect(screen.queryByText('kbps')).not.toBeInTheDocument();
  });

  it('renders the error message and destructive border when error is set', () => {
    render(<NumberField aria-label="Bitrate" error="Too small: expected number to be >=32" />);
    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveClass('border-destructive');
  });

  it('renders no error node and the normal border when error is absent', () => {
    render(<NumberField aria-label="Bitrate" />);
    expect(screen.queryByText(/too small/i)).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveClass('border-border');
  });

  it('passes disabled through to the input', () => {
    render(<NumberField aria-label="Bitrate" disabled />);
    expect(screen.getByRole('spinbutton')).toBeDisabled();
  });

  it('integrates with an RHF register spread (ref + valueAsNumber)', async () => {
    const onSubmit = vi.fn();
    render(<RHFWrapper onSubmit={onSubmit} />);
    const input = screen.getByRole('spinbutton', { name: 'Num' });
    await userEvent.clear(input);
    await userEvent.type(input, '42');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({ num: 42 });
  });
});
