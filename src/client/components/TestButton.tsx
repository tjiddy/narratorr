import { LoadingSpinner, ZapIcon } from '@/components/icons';

interface TestButtonProps {
  testing: boolean;
  onClick: () => void;
  variant: 'form' | 'inline';
  disabled?: boolean;
  title?: string;
}

export function TestButton({ testing, onClick, variant, disabled, title }: TestButtonProps) {
  const isDisabled = testing || disabled;
  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={isDisabled}
        title={title}
        className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all focus-ring"
      >
        {testing ? <LoadingSpinner className="w-4 h-4" /> : <ZapIcon className="w-4 h-4" />}
        <span className="hidden sm:inline">Test</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      className="flex items-center gap-2 px-4 py-3 font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all focus-ring"
    >
      {testing ? (
        <>
          <LoadingSpinner className="w-4 h-4" />
          Testing...
        </>
      ) : (
        <>
          <ZapIcon className="w-4 h-4" />
          Test
        </>
      )}
    </button>
  );
}
