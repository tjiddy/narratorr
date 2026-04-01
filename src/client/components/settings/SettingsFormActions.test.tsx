import { describe, it, expect, vi } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsFormActions } from './SettingsFormActions';

describe('SettingsFormActions', () => {
  it('shows Add button in create mode', () => {
    render(
      <SettingsFormActions
        isEdit={false}
        onFormTest={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    expect(screen.getByText('Add Indexer')).toBeInTheDocument();
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
  });

  it('shows Save Changes and Cancel in edit mode', () => {
    render(
      <SettingsFormActions
        isEdit={true}
        onFormTest={vi.fn()}
        onCancel={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    expect(screen.getByText('Save Changes')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows Adding... when isPending in create mode', () => {
    render(
      <SettingsFormActions
        isEdit={false}
        isPending={true}
        onFormTest={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    expect(screen.getByText('Adding...')).toBeInTheDocument();
  });

  it('shows Saving... when isPending in edit mode', () => {
    render(
      <SettingsFormActions
        isEdit={true}
        isPending={true}
        onFormTest={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <SettingsFormActions
        isEdit={true}
        onFormTest={vi.fn()}
        onCancel={onCancel}
        entityLabel="Indexer"
      />,
    );

    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onFormTest when Test button is clicked', async () => {
    const onFormTest = vi.fn();
    const user = userEvent.setup();

    render(
      <SettingsFormActions
        isEdit={false}
        onFormTest={onFormTest}
        entityLabel="Indexer"
      />,
    );

    await user.click(screen.getByText('Test').closest('button')!);
    expect(onFormTest).toHaveBeenCalled();
  });

  it('disables submit button when isPending', () => {
    render(
      <SettingsFormActions
        isEdit={false}
        isPending={true}
        onFormTest={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    const submitButton = screen.getByText('Adding...').closest('button')!;
    expect(submitButton).toBeDisabled();
  });

  it('Cancel button fires onCancel during pending submit in create mode', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <SettingsFormActions
        isEdit={false}
        isPending={true}
        onFormTest={vi.fn()}
        onCancel={onCancel}
        entityLabel="Indexer"
      />,
    );

    expect(screen.getByText('Adding...')).toBeInTheDocument();
    const submitButton = screen.getByText('Adding...').closest('button')!;
    expect(submitButton).toBeDisabled();

    const cancelButton = screen.getByText('Cancel');
    expect(cancelButton.closest('button')).not.toBeDisabled();
    await user.click(cancelButton);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows Cancel button in create mode when onCancel is provided', () => {
    render(
      <SettingsFormActions
        isEdit={false}
        onFormTest={vi.fn()}
        onCancel={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Add Indexer')).toBeInTheDocument();
  });

  it('does not show Cancel button in create mode when onCancel is not provided', () => {
    render(
      <SettingsFormActions
        isEdit={false}
        onFormTest={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
  });

  it('does not show Cancel button in edit mode when onCancel is not provided', () => {
    render(
      <SettingsFormActions
        isEdit={true}
        onFormTest={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
  });

  it('submit button has type="submit" so form submission fires on click', () => {
    render(
      <SettingsFormActions
        isEdit={false}
        onFormTest={vi.fn()}
        entityLabel="Indexer"
      />,
    );

    const submitButton = screen.getByText('Add Indexer').closest('button')!;
    expect(submitButton).toHaveAttribute('type', 'submit');
  });
});
