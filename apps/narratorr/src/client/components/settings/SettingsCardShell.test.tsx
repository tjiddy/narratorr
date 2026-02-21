import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { SettingsCardShell } from './SettingsCardShell';
import type { IdTestResult } from './SettingsCardShell';

beforeEach(() => {
  vi.clearAllMocks();
});

const baseProps = {
  name: 'Test Item',
  subtitle: 'some-subtitle',
  enabled: true,
  itemId: 1,
};

describe('SettingsCardShell', () => {
  it('renders name and subtitle', () => {
    renderWithProviders(<SettingsCardShell {...baseProps} />);

    expect(screen.getByText('Test Item')).toBeInTheDocument();
    expect(screen.getByText('some-subtitle')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SettingsCardShell {...baseProps} onEdit={onEdit} />);

    await user.click(screen.getByLabelText('Edit Test Item'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('calls onDelete when delete button is clicked', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SettingsCardShell {...baseProps} onDelete={onDelete} />);

    await user.click(screen.getByLabelText('Delete Test Item'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('calls onTest with item id when test button is clicked', async () => {
    const onTest = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SettingsCardShell {...baseProps} onTest={onTest} />);

    await user.click(screen.getByText('Test').closest('button')!);
    expect(onTest).toHaveBeenCalledWith(1);
  });

  it('shows test result when testResult.id matches itemId', () => {
    const testResult: IdTestResult = { id: 1, success: true, message: 'Connected!' };
    renderWithProviders(<SettingsCardShell {...baseProps} testResult={testResult} />);

    expect(screen.getByText('Connected!')).toBeInTheDocument();
  });

  it('does not show test result when testResult.id does not match', () => {
    const testResult: IdTestResult = { id: 99, success: true, message: 'Wrong item' };
    renderWithProviders(<SettingsCardShell {...baseProps} testResult={testResult} />);

    expect(screen.queryByText('Wrong item')).not.toBeInTheDocument();
  });

  it('renders children slot', () => {
    renderWithProviders(
      <SettingsCardShell {...baseProps}>
        <span>Extra info</span>
      </SettingsCardShell>,
    );

    expect(screen.getByText('Extra info')).toBeInTheDocument();
  });
});
