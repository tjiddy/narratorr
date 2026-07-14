// Does not use useSettingsForm: authentication form with password validation, not a settings API patch.
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ShieldIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useMutationWithToast } from '@/hooks/useMutationWithToast';
import { inputClass } from '@/components/settings/formStyles';

// Credential inputs sit in row-table rows like the rest of settings, but a username/password
// doesn't want the full card width — a fixed-width wrapper keeps the input compact and
// right-aligned (inputClass is w-full, so the wrapper sets the real width, per the NumberField/
// select idiom).
const credentialFieldWidth = 'w-64 max-w-full';
const btnPrimary = 'px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring';
const btnDestructive = 'px-5 py-3 bg-destructive text-destructive-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring';

function SetupForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutationWithToast({
    mutationFn: () => api.authSetup(username, password),
    queryKey: [queryKeys.auth.status(), queryKeys.auth.adminStatus()],
    successMessage: 'Credentials created',
    errorMessage: (err) => err instanceof ApiError ? err.message : 'Failed to create credentials',
    onSuccess: () => { setUsername(''); setPassword(''); setConfirmPassword(''); setError(''); },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    setError('');
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <SettingsTable>
        <SettingsRow htmlFor="setup-username" label="Username">
          <div className={credentialFieldWidth}>
            <input id="setup-username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={1} className={inputClass} placeholder="Enter username" />
          </div>
        </SettingsRow>
        <SettingsRow htmlFor="setup-password" label="Password">
          <div className={credentialFieldWidth}>
            <input id="setup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" className={inputClass} placeholder="Enter password" />
          </div>
        </SettingsRow>
        <SettingsRow htmlFor="setup-confirm-password" label="Confirm Password">
          <div className={credentialFieldWidth}>
            <input id="setup-confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" className={inputClass} placeholder="Confirm password" />
          </div>
        </SettingsRow>
      </SettingsTable>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <button type="submit" disabled={mutation.isPending} className={btnPrimary}>
        {mutation.isPending ? 'Creating...' : 'Create Credentials'}
      </button>
    </form>
  );
}

function ChangePasswordForm({ currentUsername, showRemoveButton, onRemove, isRemoving }: {
  currentUsername?: string;
  showRemoveButton: boolean;
  onRemove: () => void;
  isRemoving: boolean;
}) {
  const [editUsername, setEditUsername] = useState(currentUsername ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutationWithToast({
    mutationFn: () => api.authChangePassword(currentPassword, newPassword, editUsername !== currentUsername ? editUsername : undefined),
    queryKey: [queryKeys.auth.status(), queryKeys.auth.adminStatus()],
    successMessage: 'Credentials updated',
    errorMessage: (err) => err instanceof ApiError ? err.message : 'Failed to change password',
    onSuccess: () => { setCurrentPassword(''); setNewPassword(''); setConfirmNewPassword(''); setError(''); },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmNewPassword) { setError('Passwords do not match'); return; }
    setError('');
    mutation.mutate();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <SettingsTable>
          <SettingsRow htmlFor="edit-username" label="Username">
            <div className={credentialFieldWidth}>
              <input id="edit-username" type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)} required minLength={1} className={inputClass} />
            </div>
          </SettingsRow>
          <SettingsRow htmlFor="current-password" label="Current Password">
            <div className={credentialFieldWidth}>
              <input id="current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" className={inputClass} />
            </div>
          </SettingsRow>
          <SettingsRow htmlFor="new-password" label="New Password">
            <div className={credentialFieldWidth}>
              <input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoComplete="new-password" className={inputClass} placeholder="Enter new password" />
            </div>
          </SettingsRow>
          <SettingsRow htmlFor="confirm-new-password" label="Confirm New Password">
            <div className={credentialFieldWidth}>
              <input id="confirm-new-password" type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} autoComplete="new-password" className={inputClass} placeholder="Confirm new password" />
            </div>
          </SettingsRow>
        </SettingsTable>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button type="submit" disabled={mutation.isPending} className={btnPrimary}>
          {mutation.isPending ? 'Updating...' : 'Change Password'}
        </button>
      </form>
      {showRemoveButton && (
        <div className="border-t border-border pt-4">
          <p className="text-sm text-muted-foreground mb-3">
            Remove credentials and reset auth mode to None. Only available while AUTH_BYPASS is active.
          </p>
          <button type="button" onClick={onRemove} disabled={isRemoving} className={btnDestructive}>
            {isRemoving ? 'Removing...' : 'Remove Credentials'}
          </button>
        </div>
      )}
    </div>
  );
}

export function CredentialsSection({
  hasUser,
  currentUsername,
  envBypass = false,
}: {
  hasUser: boolean;
  currentUsername?: string | undefined;
  envBypass?: boolean | undefined;
}) {
  const deleteMutation = useMutationWithToast({
    mutationFn: () => api.authDeleteCredentials(),
    queryKey: [queryKeys.auth.status(), queryKeys.auth.adminStatus()],
    successMessage: 'Credentials removed',
    errorMessage: (err) => err instanceof ApiError ? err.message : 'Failed to remove credentials',
  });

  return (
    <SettingsSection
      icon={<ShieldIcon className="w-5 h-5 text-primary" />}
      title="Credentials"
      description={hasUser ? 'Manage your login credentials' : 'Create login credentials to enable authentication'}
    >
      {!hasUser ? (
        <SetupForm />
      ) : (
        <ChangePasswordForm
          {...(currentUsername !== undefined && { currentUsername })}
          showRemoveButton={envBypass && hasUser}
          onRemove={() => deleteMutation.mutate()}
          isRemoving={deleteMutation.isPending}
        />
      )}
    </SettingsSection>
  );
}
