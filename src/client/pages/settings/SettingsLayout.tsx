import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  SettingsIcon,
  SearchIcon,
  ServerIcon,
  BellIcon,
  ShieldBanIcon,
  ShieldIcon,
  HardDriveIcon,
} from '@/components/icons';

const navItems = [
  { to: '/settings', label: 'General', icon: SettingsIcon, end: true },
  { to: '/settings/indexers', label: 'Indexers', icon: SearchIcon },
  { to: '/settings/download-clients', label: 'Download Clients', icon: ServerIcon },
  { to: '/settings/notifications', label: 'Notifications', icon: BellIcon },
  { to: '/settings/blacklist', label: 'Blacklist', icon: ShieldBanIcon },
  { to: '/settings/security', label: 'Security', icon: ShieldIcon },
  { to: '/settings/system', label: 'System', icon: HardDriveIcon },
];

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
            {navItems.map((item) => {
              const isActive = item.end
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to);
              const Icon = item.icon;

              return (
                <NavLink
                  key={item.to}
                  to={item.to}
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
