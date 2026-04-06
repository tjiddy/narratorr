import type { TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { TestButton } from '@/components/TestButton';
import { Button } from '@/components/Button';
import { PencilIcon, TrashIcon } from '@/components/icons';

export interface IdTestResult extends TestResult {
  id: number;
}

interface SettingsCardShellProps {
  name: string;
  subtitle: string;
  enabled: boolean;
  itemId: number;
  onEdit?: () => void;
  onTest?: (id: number) => void;
  onDelete?: () => void;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testResultTexts?: { success: string; failure: string };
  testDisabled?: boolean;
  testDisabledTitle?: string;
  animationDelay?: string;
  children?: React.ReactNode;
}

export function SettingsCardShell({
  name,
  subtitle,
  enabled,
  itemId,
  onEdit,
  onTest,
  onDelete,
  testingId,
  testResult,
  testResultTexts = { success: 'Connected!', failure: 'Failed' },
  testDisabled,
  testDisabledTitle,
  animationDelay,
  children,
}: SettingsCardShellProps) {
  return (
    <div
      className="glass-card rounded-2xl p-5 animate-fade-in-up"
      style={animationDelay ? { animationDelay } : undefined}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className={`w-3 h-3 rounded-full shrink-0 ${enabled ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
          <div className="min-w-0">
            <h3 className="font-display font-semibold truncate">{name}</h3>
            <p className="text-sm text-muted-foreground truncate">{subtitle}</p>
            {children}
            <div className="min-h-5">
              {testResult?.id === itemId && (
                <TestResultMessage
                  success={testResult.success}
                  message={testResult.message}
                  warning={testResult.warning}
                  successText={testResultTexts.success}
                  failureText={testResultTexts.failure}
                />
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            icon={PencilIcon}
            onClick={onEdit}
            aria-label={`Edit ${name}`}
          >
            <span className="hidden sm:inline">Edit</span>
          </Button>
          <TestButton
            testing={testingId === itemId}
            onClick={() => onTest?.(itemId)}
            variant="inline"
            disabled={testDisabled}
            title={testDisabledTitle}
          />
          <Button
            variant="destructive"
            size="sm"
            icon={TrashIcon}
            onClick={onDelete}
            aria-label={`Delete ${name}`}
          >
            <span className="hidden sm:inline">Delete</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
