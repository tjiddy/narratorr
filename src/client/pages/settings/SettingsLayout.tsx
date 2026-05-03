import { NavLink, Routes, Route, useLocation } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader.js';
import { settingsPageRegistry } from './registry.js';

export function SettingsLayout() {
  const location = useLocation();

  return (
    <div className="space-y-8">
      {/* Header */}
      <PageHeader title="Settings" subtitle="Configure your Narratorr installation" />

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
                  {...(item.end !== undefined && { end: item.end })}
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
          <Routes>
            {settingsPageRegistry.map((entry) => {
              const Component = entry.component;
              return entry.path === '' ? (
                <Route key="index" index element={<Component />} />
              ) : (
                <Route key={entry.path} path={entry.path} element={<Component />} />
              );
            })}
          </Routes>
        </div>
      </div>
    </div>
  );
}
