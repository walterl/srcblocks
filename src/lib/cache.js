import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Where the cache lives: SRCBLOCKS_CACHE_DIR when set, otherwise srcblocks/
 * under the XDG cache directory. The XDG spec has an empty or relative
 * XDG_CACHE_HOME ignored in favour of ~/.cache.
 */
export function cacheDir(env, homeDir) {
    if (env.SRCBLOCKS_CACHE_DIR) {
        return env.SRCBLOCKS_CACHE_DIR;
    }
    const xdg = env.XDG_CACHE_HOME;
    const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, '.cache');
    return path.join(base, 'srcblocks');
}

export const CACHE_DIR = cacheDir(process.env, os.homedir());

/*
 * Disk cache for values that are expensive to compute and keyed by immutable
 * content (git tree SHAs), so entries never need invalidating.
 */
export async function cachedJson(namespace, key, compute) {
    const dir = path.join(CACHE_DIR, namespace);
    const file = path.join(dir, `${key}.json`);
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            // Corrupt entry; recompute and overwrite.
        }
    }

    const value = await compute();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return value;
}

/* Directory for a cached checkout, plus whether it still needs populating. */
export function treeDir(key) {
    const dir = path.join(CACHE_DIR, 'trees', key);
    return { dir, populated: fs.existsSync(path.join(dir, '.srcblocks-complete')) };
}

export function markTreePopulated(dir) {
    fs.writeFileSync(path.join(dir, '.srcblocks-complete'), '');
}
