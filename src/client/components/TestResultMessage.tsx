import { CheckIcon, AlertCircleIcon } from '@/components/icons';

interface TestResultMessageProps {
  success: boolean;
  message?: string;
  warning?: string;
  successText?: string;
  failureText?: string;
}

export function TestResultMessage({
  success,
  message,
  warning,
  successText = 'Connection successful!',
  failureText = 'Connection failed',
}: TestResultMessageProps) {
  const isWarning = success && !!warning;
  const colorClass = !success ? 'text-destructive' : isWarning ? 'text-amber-500' : 'text-success';

  return (
    <p className={`text-sm flex items-center gap-1.5 ${colorClass}`}>
      {success ? <CheckIcon className="w-3.5 h-3.5" /> : <AlertCircleIcon className="w-3.5 h-3.5" />}
      {isWarning ? warning : (message || (success ? successText : failureText))}
    </p>
  );
}
