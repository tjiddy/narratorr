/**
 * Idempotent auth setup for e2e/Lighthouse.
 * Ensures a test user exists, forms mode is enabled, and returns a session cookie.
 * Standalone module — reusable by future Playwright setup.
 *
 * Designed for dedicated test DBs (created by the orchestrator). The test user
 * credentials are fixed — if this runs against a DB with a different user,
 * it will attempt to create the test user (which fails with 409 if one exists)
 * and then try to login (which fails if credentials don't match).
 */

export const TEST_USER = { username: 'lighthouse', password: 'lighthouse-test-pass' };

export async function setupAuth(baseUrl: string): Promise<string> {
  // 1. Verify server is reachable via auth status endpoint
  const statusRes = await fetch(`${baseUrl}/api/auth/status`);
  if (!statusRes.ok) throw new Error(`Auth status check failed: ${statusRes.status}`);

  // 2. Ensure test user exists
  // Always attempt setup — POST /api/auth/setup is public when no user exists,
  // and returns 409 when a user already exists (which is fine).
  const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_USER),
  });
  if (!setupRes.ok && setupRes.status !== 409) {
    // 401 means auth mode is active and a user exists — that's expected on re-runs
    if (setupRes.status !== 401) {
      throw new Error(`Auth setup failed: ${setupRes.status}`);
    }
  }

  // 3. Enable forms mode (may fail with 401 if already in forms mode — that's fine)
  const configRes = await fetch(`${baseUrl}/api/auth/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'forms' }),
  });
  if (!configRes.ok && configRes.status !== 401) {
    throw new Error(`Auth config update failed: ${configRes.status}`);
  }

  // 4. Login to get session cookie
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_USER),
    redirect: 'manual',
  });
  if (!loginRes.ok) {
    throw new Error(
      `Login failed (${loginRes.status}). This tool expects a dedicated test DB — ` +
      `if running against an existing DB with different credentials, the orchestrator ` +
      `should create a fresh DB instead.`,
    );
  }

  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login succeeded but no session cookie returned');

  const match = setCookie.match(/narratorr_session=([^;]+)/);
  if (!match) throw new Error(`Unexpected cookie format: ${setCookie}`);

  return match[1];
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const baseUrl = process.argv[2] || 'http://localhost:3199';
  setupAuth(baseUrl)
    .then((cookie) => {
      console.log(`Auth setup complete. Session cookie: ${cookie.slice(0, 20)}...`);
    })
    .catch((err) => {
      console.error('Auth setup failed:', err);
      process.exit(1);
    });
}
