import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormField } from './FormField';

const mockRegistration = {
  name: 'testField' as const,
  onChange: async () => {},
  onBlur: async () => {},
  ref: () => {},
};

describe('FormField', () => {
  it('renders input with border-border class when no error', () => {
    render(<FormField id="test" label="Name" registration={mockRegistration} />);

    const input = screen.getByLabelText('Name');
    expect(input.className).toContain('border-border');
    expect(input.className).not.toContain('border-destructive');
  });

  it('renders input with border-destructive class and error message when error present', () => {
    render(
      <FormField
        id="test"
        label="Name"
        registration={mockRegistration}
        error={{ type: 'required', message: 'Name is required' }}
      />,
    );

    const input = screen.getByLabelText('Name');
    expect(input.className).toContain('border-destructive');
    expect(screen.getByText('Name is required')).toBeDefined();
  });

  it('renders label with correct htmlFor linkage', () => {
    render(<FormField id="myInput" label="Email" registration={mockRegistration} />);

    const label = screen.getByText('Email');
    expect(label.getAttribute('for')).toBe('myInput');
    expect(screen.getByLabelText('Email').id).toBe('myInput');
  });

  it('renders hint text when provided and no error', () => {
    render(
      <FormField
        id="test"
        label="Priority"
        registration={mockRegistration}
        hint="Lower values are checked first"
      />,
    );

    expect(screen.getByText('Lower values are checked first')).toBeDefined();
  });

  it('hides hint text when error is present', () => {
    render(
      <FormField
        id="test"
        label="Priority"
        registration={mockRegistration}
        hint="Lower values are checked first"
        error={{ type: 'min', message: 'Must be at least 1' }}
      />,
    );

    expect(screen.queryByText('Lower values are checked first')).toBeNull();
    expect(screen.getByText('Must be at least 1')).toBeDefined();
  });

  it('applies readOnly styling when readOnly is true', () => {
    render(
      <FormField id="test" label="Name" registration={mockRegistration} readOnly />,
    );

    const input = screen.getByLabelText('Name');
    expect(input.className).toContain('cursor-not-allowed');
    expect(input.getAttribute('readonly')).not.toBeNull();
  });

  it('applies disabled attribute when disabled is true', () => {
    render(
      <FormField id="test" label="Name" registration={mockRegistration} disabled />,
    );

    const input = screen.getByLabelText('Name') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.className).toContain('disabled:cursor-not-allowed');
  });

  it('passes min and max attributes to number inputs', () => {
    render(
      <FormField id="test" label="Count" registration={mockRegistration} type="number" min={1} max={10} />,
    );

    const input = screen.getByLabelText('Count');
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('10');
  });

  it('renders ReactNode hint content', () => {
    render(
      <FormField
        id="test"
        label="Script"
        registration={mockRegistration}
        hint={<>Path to <code>ffmpeg</code></>}
      />,
    );

    expect(screen.getByText('ffmpeg')).toBeDefined();
    expect(screen.getByText('ffmpeg').tagName).toBe('CODE');
  });
});
