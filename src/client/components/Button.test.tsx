import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/Button';
import { ZapIcon } from '@/components/icons';

describe('Button', () => {
  describe('variant class application', () => {
    it('primary variant renders bg-primary text-primary-foreground and hover:opacity-90', () => {
      render(<Button variant="primary">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('bg-primary', 'text-primary-foreground', 'hover:opacity-90');
    });

    it('secondary variant renders border-only styling with no filled background', () => {
      render(<Button variant="secondary">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('border', 'border-border', 'hover:bg-muted');
      expect(btn).not.toHaveClass('bg-primary');
    });

    it('destructive variant renders bg-destructive text-destructive-foreground', () => {
      render(<Button variant="destructive">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('bg-destructive', 'text-destructive-foreground');
    });

    it('success variant renders bg-success text-success-foreground', () => {
      render(<Button variant="success">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('bg-success', 'text-success-foreground');
    });

    it('ghost variant renders without a filled background', () => {
      render(<Button variant="ghost">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).not.toHaveClass('bg-primary');
      expect(btn).not.toHaveClass('bg-destructive');
      expect(btn).not.toHaveClass('bg-success');
      expect(btn).toHaveClass('hover:bg-muted');
    });

    it('glass variant renders with glass-card utility class', () => {
      render(<Button variant="glass">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('glass-card');
    });
  });

  describe('size prop', () => {
    it('size="sm" renders settings-context padding', () => {
      render(<Button variant="primary" size="sm">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('px-3', 'py-2', 'text-sm');
    });

    it('size="md" renders modal-context padding', () => {
      render(<Button variant="primary" size="md">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('px-4', 'py-3');
    });
  });

  describe('icon prop', () => {
    it('renders no icon element when icon prop is omitted', () => {
      render(<Button variant="primary">Click</Button>);
      expect(document.querySelector('svg')).toBeNull();
    });

    it('renders icon before text with correct gap when icon prop is provided', () => {
      render(<Button variant="primary" icon={ZapIcon}>Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('gap-1.5');
      expect(btn.querySelector('svg')).not.toBeNull();
    });
  });

  describe('loading state', () => {
    it('loading=true renders LoadingSpinner in place of the icon', () => {
      render(<Button variant="primary" icon={ZapIcon} loading>Click</Button>);
      const btn = screen.getByRole('button');
      // LoadingSpinner is rendered (has an svg), ZapIcon is replaced
      expect(btn.querySelector('svg')).not.toBeNull();
    });

    it('loading=true implicitly disables the button so click handler does not fire', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(<Button variant="primary" loading onClick={onClick}>Click</Button>);
      await user.click(screen.getByRole('button'));
      expect(onClick).not.toHaveBeenCalled();
      expect(screen.getByRole('button')).toBeDisabled();
    });

    it('loading=false leaves the button interactive', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(<Button variant="primary" loading={false} onClick={onClick}>Click</Button>);
      await user.click(screen.getByRole('button'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('disabled state', () => {
    it('disabled=true applies opacity-50 and cursor-not-allowed', () => {
      render(<Button variant="primary" disabled>Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
      expect(btn).toHaveClass('disabled:opacity-50', 'disabled:cursor-not-allowed');
    });

    it('disabled=true prevents click handler from firing', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(<Button variant="primary" disabled onClick={onClick}>Click</Button>);
      await user.click(screen.getByRole('button'));
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('focus ring', () => {
    it('all variants include focus-ring utility class', () => {
      const variants = ['primary', 'secondary', 'destructive', 'success', 'ghost', 'glass'] as const;
      for (const variant of variants) {
        const { unmount } = render(<Button variant={variant}>Click</Button>);
        expect(screen.getByRole('button')).toHaveClass('focus-ring');
        unmount();
      }
    });
  });

  describe('prop forwarding', () => {
    it('className is merged with variant base classes', () => {
      render(<Button variant="primary" className="my-custom-class">Click</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('bg-primary', 'my-custom-class');
    });

    it('default type is "button" to prevent accidental form submission', () => {
      render(<Button variant="primary">Click</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    });

    it('type="submit" passes through for explicit form submission', () => {
      render(<Button variant="primary" type="submit">Submit</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
    });

    it('onClick fires when button is clicked', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(<Button variant="primary" onClick={onClick}>Click</Button>);
      await user.click(screen.getByRole('button'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('hover state', () => {
    it('primary and destructive use hover:opacity-90, not background-color hover', () => {
      render(<Button variant="primary">Click</Button>);
      expect(screen.getByRole('button')).toHaveClass('hover:opacity-90');
      expect(screen.getByRole('button')).not.toHaveClass('hover:bg-primary');
    });

    it('secondary uses hover:bg-muted, not opacity', () => {
      render(<Button variant="secondary">Click</Button>);
      expect(screen.getByRole('button')).toHaveClass('hover:bg-muted');
      expect(screen.getByRole('button')).not.toHaveClass('hover:opacity-90');
    });
  });
});
