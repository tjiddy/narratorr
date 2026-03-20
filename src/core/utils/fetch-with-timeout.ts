/**
 * Fetch with an automatic timeout via AbortSignal.timeout().
 * Replaces manual AbortController + setTimeout boilerplate.
 *
 * 3xx responses are detected and thrown as descriptive Errors before returning
 * to callers. All download-client and notifier test() paths surface error.message
 * via their existing try/catch, so no caller changes are needed.
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    const target = location ? `to ${location} ` : '';
    throw new Error(
      `Server redirected ${target}— an auth proxy may be intercepting requests. ` +
        `Use the service's internal address or whitelist this endpoint in your proxy config.`,
    );
  }

  return response;
}
