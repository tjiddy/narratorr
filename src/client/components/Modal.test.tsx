import { describe, it } from 'vitest';

describe('Modal', () => {
  it.todo('renders backdrop with bg-black/80 backdrop-blur-sm and data-testid="modal-backdrop"');
  it.todo('renders fixed overlay with z-50 and animate-fade-in');
  it.todo('renders children inside the panel with animate-fade-in-up');
  it.todo('calls onClose when backdrop is clicked and onClose is provided');
  it.todo('does not throw when backdrop is clicked and onClose is not provided (WelcomeModal case)');
  it.todo('does not call onClose when clicking inside the modal panel (stopPropagation)');
  it.todo('scrollable prop applies inner-scroll layout to the panel');
  it.todo('passes className through to the panel wrapper');
});
