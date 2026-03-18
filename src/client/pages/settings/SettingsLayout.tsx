import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { settingsPageRegistry } from './registry.js';

export function SettingsLayout() {
  const location = useLocation();

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="animate-fade-in-up">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
          Settings
        </h1>
        <p className="text-muted-foreground mt-2">
          Configure your Narratorr installation
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Navigation Sidebar */}
        <nav className="lg:w-56 shrink-0 animate-fade-in-up stagger-1">
          <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
            {settingsPageRegistry.map((item) => {
              const to = item.path ? `/settings/${item.path}` : '/settings';
              const isActive = item.end
                ? location.pathname === to
                : location.pathname.startsWith(to);
              const Icon = item.icon;

              return (
                <NavLink
                  key={to}
                  to={to}
                  end={item.end}
                  className={`
                    flex items-center gap-3 px-4 py-3 rounded-xl whitespace-nowrap
                    transition-all duration-200
                    ${isActive
                      ? 'bg-primary text-primary-foreground shadow-glow'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }
                  `}
                >
                  <Icon className="w-5 h-5" />
                  <span className="font-medium">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 animate-fade-in-up stagger-2">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
