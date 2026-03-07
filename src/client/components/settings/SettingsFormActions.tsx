import { TestButton } from '@/components/TestButton';
import { LoadingSpinner, PlusIcon, CheckIcon, XIcon } from '@/components/icons';

interface SettingsFormActionsProps {
  isEdit: boolean;
  isPending?: boolean;
  testingForm?: boolean;
  onFormTest: () => void;
  onCancel?: () => void;
  entityLabel: string;
  testDisabled?: boolean;
  testDisabledTitle?: string;
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
      {isEdit && (
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-2 px-4 py-3 font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
        >
          <XIcon className="w-4 h-4" />
          Cancel
        </button>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
      >
        {isPending ? (
          <>
            <LoadingSpinner className="w-4 h-4" />
            {isEdit ? 'Saving...' : 'Adding...'}
          </>
        ) : (
          <>
            {isEdit ? <CheckIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
            {isEdit ? 'Save Changes' : `Add ${entityLabel}`}
          </>
        )}
      </button>
    </div>
  );
}
