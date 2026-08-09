// Side-effect-free subpath topology; importing Playwright config in a worker would recreate temp dirs.

export const SUBPATH_RUN = 'subpath';

export const ROOT_PORT = 3100;

export const SUBPATH_PORT = 3101;

export const URL_BASE_SUBPATH = '/narratorr';

/**
 * The trailing slash is load-bearing: Playwright resolves relative navigation under
 * `/narratorr`, while a leading slash escapes to the origin root.
 */
export const SUBPATH_BASE_URL = `http://localhost:${SUBPATH_PORT}${URL_BASE_SUBPATH}/`;
