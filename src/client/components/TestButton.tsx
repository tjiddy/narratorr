import { Button } from '@/components/Button';
import { ZapIcon } from '@/components/icons';

interface TestButtonProps {
  testing: boolean;
  onClick: () => void;
  variant: 'form' | 'inline';
  disabled?: boolean | undefined;
  title?: string | undefined;
}

export function TestButton({ testing, onClick, variant, disabled, title }: TestButtonProps) {
  const isDisabled = testing || disabled;
  const size = variant === 'inline' ? 'sm' : 'md';

  return (
    <Button
      variant="secondary"
      size={size}
      icon={ZapIcon}
      loading={testing}
      disabled={isDisabled}
      onClick={onClick}
      title={title}
      type="button"
      className="disabled:hover:bg-transparent"
    >
      {variant === 'form' ? (
        testing ? 'Testing...' : 'Test'
      ) : (
        <span className="hidden sm:inline">Test</span>
      )}
    </Button>
  );
}
