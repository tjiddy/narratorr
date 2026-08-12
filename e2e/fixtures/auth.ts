import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Side-effect-free forms topology; importing Playwright config in a worker would recreate temp dirs.

export const FORMS_RUN = 'forms';

// Dedicated non-bypass server for real login/session flows.
export const FORMS_PORT = 3102;

// No trailing slash: forms routes are origin-rooted under `URL_BASE=/`.
export const FORMS_BASE_URL = `http://localhost:${FORMS_PORT}`;

export const FORMS_USERNAME = 'e2e-forms-user';
export const FORMS_PASSWORD = 'e2e-forms-pass-1234';

// Resolve cwd-independently; `.auth` is gitignored because storage state contains a live session cookie.
export const AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth', 'forms-user.json');
