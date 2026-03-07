import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';
import type { Mock } from 'vitest';
import { toast } from 'sonner';

/** Wait for the CRUD list to finish loading by checking for an item name. */
export async function waitForListLoad(itemName: string) {
  await waitFor(() => {
    expect(screen.getByText(itemName)).toBeInTheDocument();
  });
}

/** Find the "Delete" confirm button inside a dialog. Replaces fragile querySelectorAll pattern. */
export function getDeleteConfirmButton(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  const button = Array.from(dialog.querySelectorAll('button')).find(
    (btn) => btn.textContent === 'Delete',
  );
  if (!button) throw new Error('Delete confirm button not found in dialog');
  return button;
}

/** Full delete confirmation flow: click delete → verify modal → confirm → assert API call + success toast. */
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
    expect(deleteApi.mock.calls[0][0]).toBe(expectedId);
  });

  await assertSuccessToast(`${entityName} removed successfully`);
}

/** Click delete, cancel, verify modal dismissed and no API call. */
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

/** Click delete, confirm, and assert error toast. Caller must set up mock rejection before calling. */
export async function assertDeleteError(
  user: UserEvent,
  itemName: string,
  entityName: string,
) {
  await user.click(screen.getByLabelText(`Delete ${itemName}`));
  await user.click(getDeleteConfirmButton());
  await assertErrorToast(`Failed to delete ${entityName.toLowerCase()}`);
}

/** Toggle add form: click add → assert form shows → click cancel → assert form hides. */
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

/** Assert a success toast was shown. */
export async function assertSuccessToast(message: string) {
  await waitFor(() => {
    expect(toast.success).toHaveBeenCalledWith(message);
  });
}

/** Assert an error toast was shown. */
export async function assertErrorToast(message: string) {
  await waitFor(() => {
    expect(toast.error).toHaveBeenCalledWith(message);
  });
}
