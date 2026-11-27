import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTree, treeSha } from '#srcblocks/git/repo.js';
import { buildCallGraph } from '#srcblocks/analyze/graph.js';
import { cachedJson, treeDir, markTreePopulated } from '#srcblocks/lib/cache.js';

/*
 * A cached graph is only as good as the analyser that produced it, and a tree
 * SHA says nothing about that. Hashing the analyser's own source into the key
 * retires every cached graph the moment the analyser changes - otherwise a new
 * kind of node silently never appears for a repository already analysed.
 */
const analyzerFingerprint = () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const hash = crypto.createHash('sha1');
    for (const file of fs.readdirSync(dir).sort()) {
        if (file.endsWith('.js')) {
            hash.update(fs.readFileSync(path.join(dir, file)));
        }
    }
    return hash.digest('hex').slice(0, 8);
};

const FINGERPRINT = analyzerFingerprint();

const cacheKey = (tree, include) =>
    `${tree}-${include && include.length ? include.join('+').replace(/\//g, '_') : 'all'}-${FINGERPRINT}`;

/*
 * The call graph of one revision of `repoDir`.
 *
 * Revisions are read through `git archive` into a cache directory, so the
 * repository being navigated is never modified (no checkout, no worktree).
 * Both the extracted tree and the resulting graph are cached by tree SHA, which
 * makes repeated analysis of a branch's commits cheap.
 */
export async function graphForRev(repoDir, ref, { include = null } = {}) {
    const tree = await treeSha(repoDir, ref);

    return cachedJson('graphs', cacheKey(tree, include), async () => {
        const { dir, populated } = treeDir(tree);
        if (!populated) {
            fs.mkdirSync(dir, { recursive: true });
            await extractTree(repoDir, ref, dir);
            markTreePopulated(dir);
        }
        return { tree, ...buildCallGraph({ rootDir: dir, include }) };
    });
}
