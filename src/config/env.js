import path from 'node:path';

const list = value =>
    (value || '')
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean);

/* The repository being navigated; defaults to the current working directory. */
export const REPO_DIR = path.resolve(process.env.SRCBLOCKS_REPO || process.cwd());

/*
 * Path prefixes that become graph nodes, e.g. 'src'. Everything outside them is
 * still parsed (so calls into it resolve) but is not drawn. Empty means "all".
 */
export const INCLUDE = list(process.env.SRCBLOCKS_INCLUDE);

/*
 * Extra packages to treat as services (I/O boundaries) beside the built-in
 * list, e.g. an in-house http client. Comma-separated package names.
 */
export const SERVICES = list(process.env.SRCBLOCKS_SERVICES);

export const PORT = Number(process.env.PORT || 4173);
export const HOST = process.env.HOST || '127.0.0.1';
