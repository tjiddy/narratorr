import { useState } from 'react';
import { Outlet, NavLink, useLocation, Link } from 'react-router-dom';
import { useTheme } from '@/hooks/useTheme';
import { useActivityCounts } from '@/hooks/useActivityCounts';
import { useAuthContext } from '@/hooks/useAuthContext';
import {
  HeadphonesIcon,
  SearchIcon,
  ActivityIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  LibraryIcon,
  AlertTriangleIcon,
  XIcon,
} from '@/components/icons';

const BANNER_DISMISSED_KEY = 'narratorr:auth-banner-dismissed';

const navItems = [
  { to: '/library', label: 'Library', icon: LibraryIcon },
  { to: '/search', label: 'Search', icon: SearchIcon },
  { to: '/activity', label: 'Activity', icon: ActivityIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Layout() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const { active: activeDownloadCount } = useActivityCounts();
  const { mode } = useAuthContext();
  const [bannerDismissed, setBannerDismissed] = useState(
    () => localStorage.getItem(BANNER_DISMISSED_KEY) === 'true',
  );

  function dismissBanner() {
    setBannerDismissed(true);
    localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
  }

  return (
    <div className="min-h-screen gradient-bg noise-overlay">
      {/* Auth Warning Banner */}
      {mode === 'none' && !bannerDismissed && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 animate-fade-in">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangleIcon className="w-4 h-4 shrink-0" />
              <span>
                Authentication is disabled.{' '}
                <Link
                  to="/settings/security"
                  className="underline underline-offset-2 font-medium hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
                >
                  Configure it in Settings &gt; Security
                </Link>
              </span>
            </div>
            <button
              onClick={dismissBanner}
              className="shrink-0 p-1.5 rounded-lg text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
              aria-label="Dismiss auth warning"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-background/80 border-b border-border/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 sm:h-20">
            {/* Logo */}
            <NavLink
              to="/"
              className="flex items-center gap-3 group"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-xl blur-xl group-hover:bg-primary/30 transition-colors" />
                <div className="relative bg-gradient-to-br from-primary to-amber-500 p-2.5 rounded-xl">
                  <HeadphonesIcon className="w-6 h-6 text-primary-foreground" />
                </div>
              </div>
              <span className="font-display text-2xl sm:text-3xl font-semibold tracking-tight">
                narratorr
              </span>
            </NavLink>

            {/* Navigation */}
            <nav className="flex items-center gap-1 sm:gap-2">
              {navItems.map((item) => {
                const isActive = location.pathname.startsWith(item.to);
                const Icon = item.icon;

                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={`
                      relative flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl text-sm font-medium
                      transition-all duration-200 ease-out
                      ${isActive
                        ? 'text-primary-foreground bg-primary shadow-glow'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      }
                    `}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="hidden sm:inline">{item.label}</span>
                    {item.to === '/activity' && activeDownloadCount > 0 && (
                      <span
                        className={`
                          absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1
                          rounded-full text-[10px] font-bold
                          flex items-center justify-center leading-none
                          ${isActive
                            ? 'bg-primary-foreground text-primary'
                            : 'bg-primary text-primary-foreground'
                          }
                        `}
                        aria-label={`${activeDownloadCount} active download${activeDownloadCount === 1 ? '' : 's'}`}
                      >
                        {activeDownloadCount}
                      </span>
                    )}
                  </NavLink>
                );
              })}

              {/* Theme Toggle */}
              <button
                onClick={toggleTheme}
                className="ml-2 p-2.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200 focus-ring"
                title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              >
                {theme === 'light' ? (
                  <MoonIcon className="w-5 h-5" />
                ) : (
                  <SunIcon className="w-5 h-5" />
                )}
              </button>
            </nav>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-center text-sm text-muted-foreground">
            Narratorr &mdash; Your personal audiobook library
          </p>
        </div>
      </footer>
    </div>
  );
}
