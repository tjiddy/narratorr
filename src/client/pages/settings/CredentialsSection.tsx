import { useState, type FormEvent } from 'react';
import { useMutation, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ShieldIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';

export function CredentialsSection({
  hasUser,
  currentUsername,
  queryClient,
}: {
  hasUser: boolean;
  currentUsername?: string;
  queryClient: QueryClient;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [editUsername, setEditUsername] = useState(currentUsername ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const setupMutation = useMutation({
    mutationFn: () => api.authSetup(username, password),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.status() });
      toast.success('Credentials created');
      setUsername('');
      setPassword('');
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Failed to create credentials';
      toast.error(message);
    },
  });

  const passwordMutation = useMutation({
    mutationFn: () => api.authChangePassword(currentPassword, newPassword, editUsername !== currentUsername ? editUsername : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.status() });
      toast.success('Credentials updated');
      setCurrentPassword('');
      setNewPassword('');
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Failed to change password';
      toast.error(message);
    },
  });

  function handleSetup(e: FormEvent) {
    e.preventDefault();
    setupMutation.mutate();
  }

  function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    passwordMutation.mutate();
  }

  return (
    <SettingsSection
      icon={<ShieldIcon className="w-5 h-5 text-primary" />}
      title="Credentials"
      description={hasUser ? 'Manage your login credentials' : 'Create login credentials to enable authentication'}
    >
      {!hasUser ? (
        <form onSubmit={handleSetup} className="space-y-4">
          <div>
            <label htmlFor="setup-username" className="block text-sm font-medium mb-1.5">Username</label>
            <input
              id="setup-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={1}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              placeholder="Enter username"
            />
          </div>
          <div>
            <label htmlFor="setup-password" className="block text-sm font-medium mb-1.5">Password</label>
            <input
              id="setup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              placeholder="Enter password"
            />
          </div>
          <button
            type="submit"
            disabled={setupMutation.isPending}
            className="px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
          >
            {setupMutation.isPending ? 'Creating...' : 'Create Credentials'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label htmlFor="edit-username" className="block text-sm font-medium mb-1.5">Username</label>
            <input
              id="edit-username"
              type="text"
              value={editUsername}
              onChange={(e) => setEditUsername(e.target.value)}
              required
              minLength={1}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            />
          </div>
          <div>
            <label htmlFor="current-password" className="block text-sm font-medium mb-1.5">Current Password</label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            />
          </div>
          <div>
            <label htmlFor="new-password" className="block text-sm font-medium mb-1.5">New Password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              placeholder="Enter new password"
            />
          </div>
          <button
            type="submit"
            disabled={passwordMutation.isPending}
            className="px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
          >
            {passwordMutation.isPending ? 'Updating...' : 'Change Password'}
          </button>
        </form>
      )}
    </SettingsSection>
  );
}
