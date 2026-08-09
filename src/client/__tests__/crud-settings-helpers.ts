import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';
import type { Mock } from 'vitest';
import { toast } from 'sonner';

export async function waitForListLoad(itemName: string) {
  await waitFor(() => {
    expect(screen.getByText(itemName)).toBeInTheDocument();
  });
}

export function getDeleteConfirmButton(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  return within(dialog).getByRole('button', { name: 'Delete' });
}

export async function assertDeleteFlow(
  user: UserEvent,
  itemName: string,
  deleteApi: Mock,
  expectedId: number,
  entityName: string,
) {
  await user.click(screen.getByLabelText(`Delete ${itemName}`));

  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(
    screen.getByText(new RegExp(`Are you sure you want to delete "${itemName}"`)),
  ).toBeInTheDocument();

  await user.click(getDeleteConfirmButton());

  await waitFor(() => {
    expect(deleteApi.mock.calls[0]![0]).toBe(expectedId);
  });

  await assertSuccessToast(`${entityName} removed successfully`);
}

export async function assertCancelDelete(
  user: UserEvent,
  itemName: string,
  deleteApi: Mock,
) {
  await user.click(screen.getByLabelText(`Delete ${itemName}`));
  await user.click(screen.getByText('Cancel'));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(deleteApi).not.toHaveBeenCalled();
}

/** Requires the delete API mock to reject first. */
export async function assertDeleteError(
  user: UserEvent,
  itemName: string,
  entityName: string,
) {
  await user.click(screen.getByLabelText(`Delete ${itemName}`));
  await user.click(getDeleteConfirmButton());
  await assertErrorToast(`Failed to delete ${entityName.toLowerCase()}`);
}

export async function assertToggleAddForm(
  user: UserEvent,
  addButtonText: string,
  formTitle: string,
) {
  await user.click(screen.getByText(addButtonText).closest('button')!);
  expect(screen.getByText(formTitle)).toBeInTheDocument();

  await user.click(screen.getByText('Cancel').closest('button')!);
  expect(screen.queryByText(formTitle)).not.toBeInTheDocument();
}

export async function assertSuccessToast(message: string) {
  await waitFor(() => {
    expect(toast.success).toHaveBeenCalledWith(message);
  });
}

export async function assertErrorToast(message: string) {
  await waitFor(() => {
    expect(toast.error).toHaveBeenCalledWith(message);
  });
}
