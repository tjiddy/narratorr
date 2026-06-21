import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Single source of truth for the forms-auth (login/session) E2E topology — see
 * issue #1555.
 *
 * Both `playwright.config.ts` (forms server env + project baseURL + health-check
 * URL + storageState path) and the auth specs import these so the port, base URL,
 * credentials, and auth-file path stay in sync. The specs cannot import
 * `playwright.config.ts` directly (importing it re-runs `createRunTempDirs()` as
 * an import side effect in the worker process), so the shared constants live in
 * this side-effect-free module instead — mirroring `subpath.ts`.
 */

/** Named run key for the forms server's isolated temp dirs (see temp-dirs.ts). */
export const FORMS_RUN = 'forms';

/**
 * Forms server port — a third `URL_BASE=/` server booted WITHOUT `AUTH_BYPASS`
 * so the real login/session/redirect loop is exercised. Distinct from the root
 * (3100) and subpath (3101) servers.
 */
export const FORMS_PORT = 3102;

/**
 * Per-project Playwright `baseURL` for the forms server. No trailing slash —
 * the forms server mounts at `URL_BASE=/`, so leading-slash app paths
 * (`page.goto('/library')`) and API paths (`page.request.post('/api/auth/login')`)
 * resolve origin-rooted, mirroring the root project.
 */
export const FORMS_BASE_URL = `http://localhost:${FORMS_PORT}`;

/** Credentials the setup project bootstraps and the forms specs log in with. */
export const FORMS_USERNAME = 'e2e-forms-user';
export const FORMS_PASSWORD = 'e2e-forms-pass-1234';

/**
 * Absolute path the setup project writes the authenticated `storageState` to and
 * the forms project reuses. Resolved from this module's location so it is
 * cwd-independent. The enclosing `e2e/.auth/` directory is gitignored (it holds
 * a live session cookie — must never be committed).
 */
export const AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth', 'forms-user.json');
