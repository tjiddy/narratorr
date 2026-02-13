import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useTheme } from '@/hooks/useTheme';
import {
  HeadphonesIcon,
  SearchIcon,
  ActivityIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  LibraryIcon,
} from '@/components/icons';

const navItems = [
  { to: '/library', label: 'Library', icon: LibraryIcon },
  { to: '/search', label: 'Search', icon: SearchIcon },
  { to: '/activity', label: 'Activity', icon: ActivityIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Layout() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  return (
    <div className="min-h-screen gradient-bg noise-overlay">
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
