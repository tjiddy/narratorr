import { TestButton } from '@/components/TestButton';
import { Button } from '@/components/Button';
import { PlusIcon, CheckIcon, XIcon } from '@/components/icons';

interface SettingsFormActionsProps {
  isEdit: boolean;
  isPending?: boolean | undefined;
  testingForm?: boolean | undefined;
  onFormTest: () => void;
  onCancel?: (() => void) | undefined;
  entityLabel: string;
  testDisabled?: boolean | undefined;
  testDisabledTitle?: string | undefined;
}

export function SettingsFormActions({
  isEdit,
  isPending,
  testingForm,
  onFormTest,
  onCancel,
  entityLabel,
  testDisabled,
  testDisabledTitle,
}: SettingsFormActionsProps) {
  return (
    <div className="flex items-center gap-3">
      <TestButton
        testing={!!testingForm}
        onClick={onFormTest}
        variant="form"
        disabled={testDisabled}
        title={testDisabledTitle}
      />
      {onCancel && (
        <Button
          variant="secondary"
          size="md"
          icon={XIcon}
          type="button"
          onClick={onCancel}
        >
          Cancel
        </Button>
      )}
      <Button
        variant="primary"
        size="md"
        icon={isEdit ? CheckIcon : PlusIcon}
        loading={isPending}
        type="submit"
      >
        {isPending
          ? (isEdit ? 'Saving...' : 'Adding...')
          : (isEdit ? 'Save Changes' : `Add ${entityLabel}`)}
      </Button>
    </div>
  );
}
