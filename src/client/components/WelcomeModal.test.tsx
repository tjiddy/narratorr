import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WelcomeModal } from './WelcomeModal';

describe('WelcomeModal', () => {
  const onDismiss = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when isOpen is true — shows title, all row sections, footer text, and Get Started button', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Welcome to narratorr')).toBeInTheDocument();
    expect(screen.getByText('Read This First')).toBeInTheDocument();
    expect(screen.getByText('First Steps')).toBeInTheDocument();
    expect(screen.getByText('Features Worth Knowing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument();
    expect(screen.getByText('You can view this again anytime in Settings')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<WelcomeModal isOpen={false} onDismiss={onDismiss} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Get Started" button calls onDismiss when clicked', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('Get Started button is disabled while isPending is true', () => {
    render(<WelcomeModal isOpen isPending onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
  });

  it('Get Started button shows "Saving..." text while isPending', () => {
    render(<WelcomeModal isOpen isPending onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /saving/i })).toHaveTextContent('Saving...');
  });

  it('Row 1 cards each have a warning badge', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    // 3 warning badges for the 3 "Read This" cards
    const badges = screen.getAllByLabelText('Important');
    expect(badges).toHaveLength(3);
  });

  it('footer text "You can view this again anytime in Settings" is present', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByText('You can view this again anytime in Settings')).toBeInTheDocument();
  });

  it('Get Started button has type="button" to prevent accidental form submission', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /get started/i })).toHaveAttribute('type', 'button');
  });

  it('pressing Escape does NOT close the modal (onboarding requires explicit Get Started)', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);

    await user.keyboard('{Escape}');

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Scroll lock (AC1)
  it('sets document.body overflow to hidden while modal is open', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores document.body overflow to its original value on close/unmount', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = ''; // cleanup
  });

  // Focus trap (AC2) — updated for 11 tabbable elements (10 card links + Get Started button)
  it('places focus on the dialog container (not first card) when modal opens', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('places focus on dialog container when isPending=true (card links remain active but keyboard focus is locked to container)', () => {
    render(<WelcomeModal isOpen isPending onDismiss={onDismiss} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('Tab from Get Started button wraps forward to first card link', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const button = screen.getByRole('button', { name: /get started/i });
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Tab}');
    const links = screen.getAllByRole('link');
    expect(document.activeElement).toBe(links[0]);
  });

  it('Shift+Tab from first card link wraps backward to Get Started button', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const links = screen.getAllByRole('link');
    act(() => links[0].focus());
    expect(document.activeElement).toBe(links[0]);
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /get started/i }));
  });

  it('Tab key does not move focus outside the modal', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    await user.keyboard('{Tab}');
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // Mobile scroll — dialog div must participate in flex layout so inner content can scroll
  it('dialog container has flex layout and overflow-hidden for mobile scroll support', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('flex');
    expect(dialog.className).toContain('overflow-hidden');
    expect(dialog.className).toContain('min-h-0');
  });

  it('dialog container has outline-none to suppress focus ring', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('outline-none');
  });

  // Backdrop non-dismiss (AC — clicking outside does not close the modal)
  it('clicking the backdrop does not dismiss the modal', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    // Modal has no onClose prop — backdrop click is a no-op by design
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // #169 — Welcome modal polish

  // Scroll-to-top (AC2)
  it('scrollable content container scrollTop is 0 when modal opens', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const content = screen.getByTestId('modal-content');
    expect(content.scrollTop).toBe(0);
  });

  it('scrollable content container scrollTop resets to 0 when modal is re-opened after dismiss', () => {
    const { rerender } = render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    rerender(<WelcomeModal isOpen={false} onDismiss={onDismiss} />);
    rerender(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const content = screen.getByTestId('modal-content');
    expect(content.scrollTop).toBe(0);
  });

  // Icon swap (AC3)
  it('header displays HeadphonesIcon, not BookOpenIcon', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const iconContainer = screen.getByTestId('welcome-header-icon');
    const svg = iconContainer.querySelector('svg');
    // HeadphonesIcon uses strokeWidth="1.5"; BookOpenIcon uses strokeWidth="2"
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });

  // Clickable cards (AC4)
  it('all 10 cards render as <a> links with target="_blank" and rel="noopener noreferrer"', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(10);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('Authentication is off card links to https://docs.narratorr.dev/configuration/security/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /authentication is off/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/configuration/security/',
    );
  });

  it('Metadata region: US card links to https://docs.narratorr.dev/configuration/metadata/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /metadata region/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/configuration/metadata/',
    );
  });

  it('Library path card links to https://docs.narratorr.dev/configuration/library/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    // Use "Library path:" with colon to distinguish from "Library Import"
    expect(screen.getByRole('link', { name: /Library path:/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/configuration/library/',
    );
  });

  it('Library Import card links to https://docs.narratorr.dev/guides/library-import/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /library import/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/guides/library-import/',
    );
  });

  it('Manual Import card links to https://docs.narratorr.dev/guides/manual-import/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /manual import/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/guides/manual-import/',
    );
  });

  it('Add a Book card links to https://docs.narratorr.dev/getting-started/first-run/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /add a book/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/getting-started/first-run/',
    );
  });

  it('List Importing card links to https://docs.narratorr.dev/guides/import-lists/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /list importing/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/guides/import-lists/',
    );
  });

  it('Post Processing card links to https://docs.narratorr.dev/guides/audio-processing/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /post processing/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/guides/audio-processing/',
    );
  });

  it('Prowlarr Support card links to https://docs.narratorr.dev/configuration/indexers/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /prowlarr support/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/configuration/indexers/',
    );
  });

  it('Recommendations card links to https://docs.narratorr.dev/guides/discovery/', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('link', { name: /recommendations/i })).toHaveAttribute(
      'href',
      'https://docs.narratorr.dev/guides/discovery/',
    );
  });

  it('clicking a card link does not call onDismiss', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    await user.click(screen.getByRole('link', { name: /authentication is off/i }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // Hover state (AC5)
  it('card links have cursor-pointer class', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('cursor-pointer');
    }
  });

  it('card links have at least one hover: background or border class', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toMatch(/hover:/);
    }
  });

  // Settings → nowrap (AC8)
  it('"Settings → Security" in Auth card description is wrapped in whitespace-nowrap span', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const nowrapSpans = document.querySelectorAll('.whitespace-nowrap');
    const texts = Array.from(nowrapSpans).map((el) => el.textContent);
    expect(texts.some((t) => t?.includes('Settings → Security'))).toBe(true);
  });

  it('"Settings → Metadata" in Metadata region card description is wrapped in whitespace-nowrap span', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const nowrapSpans = document.querySelectorAll('.whitespace-nowrap');
    const texts = Array.from(nowrapSpans).map((el) => el.textContent);
    expect(texts.some((t) => t?.includes('Settings → Metadata'))).toBe(true);
  });

  it('"Settings → Library" in Library path card description is wrapped in whitespace-nowrap span', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const nowrapSpans = document.querySelectorAll('.whitespace-nowrap');
    const texts = Array.from(nowrapSpans).map((el) => el.textContent);
    expect(texts.some((t) => t?.includes('Settings → Library'))).toBe(true);
  });

  // Copy changes (AC7, AC9)
  it('Audible region card title reads "Metadata region: US"', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByText('Metadata region: US')).toBeInTheDocument();
    expect(screen.queryByText('Audible region: US')).not.toBeInTheDocument();
  });

  it('Audible region card description reads "Metadata searches default to the US region. Change it in Settings → Metadata."', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(
      screen.getByText(/Metadata searches default to the US region\. Change it in/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/US Audible store/)).not.toBeInTheDocument();
  });

  it('List Importing card description reads "Bulk-import books from lists and monitor them automatically."', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(
      screen.getByText('Bulk-import books from lists and monitor them automatically.'),
    ).toBeInTheDocument();
  });

  it('Recommendations card description reads "Personalised suggestions based on your library. Discover what to read next."', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(
      screen.getByText('Personalised suggestions based on your library. Discover what to read next.'),
    ).toBeInTheDocument();
  });

  it('Post Processing card description reads "Auto-convert to M4B after import. Chapters, cover art, and more."', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(
      screen.getByText('Auto-convert to M4B after import. Chapters, cover art, and more.'),
    ).toBeInTheDocument();
  });

  // Keyboard navigation with 10 tabbable links + Get Started button
  it('initial focus lands on dialog container, not any card link', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('Tab from the last card link moves focus to the Get Started button', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const links = screen.getAllByRole('link');
    act(() => links[links.length - 1].focus());
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /get started/i }));
  });

  it('Shift-Tab from the Get Started button moves focus to the last card link', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const button = screen.getByRole('button', { name: /get started/i });
    act(() => button.focus());
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    const links = screen.getAllByRole('link');
    expect(document.activeElement).toBe(links[links.length - 1]);
  });

  it('pressing Enter on a card link does not call onDismiss', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const links = screen.getAllByRole('link');
    act(() => links[0].focus());
    await user.keyboard('{Enter}');
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
