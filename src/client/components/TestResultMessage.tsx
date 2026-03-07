import { CheckIcon, AlertCircleIcon } from '@/components/icons';

interface TestResultMessageProps {
  success: boolean;
  message?: string;
  successText?: string;
  failureText?: string;
}

export function TestResultMessage({
  success,
  message,
  successText = 'Connection successful!',
  failureText = 'Connection failed',
}: TestResultMessageProps) {
  return (
    <p className={`text-sm flex items-center gap-1.5 ${success ? 'text-success' : 'text-destructive'}`}>
      {success ? <CheckIcon className="w-3.5 h-3.5" /> : <AlertCircleIcon className="w-3.5 h-3.5" />}
      {message || (success ? successText : failureText)}
    </p>
  );
}
