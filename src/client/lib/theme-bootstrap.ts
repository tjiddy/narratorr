/**
 * Apply the stored or system-preferred theme to <html> before first paint.
 * Mirrors the inline IIFE in index.html — extracted for testability.
 */
export function applyTheme(): void {
  let t = localStorage.getItem('theme');
  if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (t === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  document.documentElement.style.background = t === 'dark' ? 'hsl(30 8% 7%)' : 'hsl(30 10% 98%)';
}
