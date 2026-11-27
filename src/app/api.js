import { INCLUDE, REPO_DIR } from '#srcblocks/config/env.js';
import { logger } from '#srcblocks/config/logger.js';
import {
    baseCandidates,
    defaultBase,
    defaultBranch,
    isGitRepo,
    listBranches,
    resolveRef,
} from '#srcblocks/git/repo.js';
import { graphForRev } from '#srcblocks/analyze/revision.js';
import { analyzeBranch } from '#srcblocks/analyze/branch.js';
import { fileAt, fileDiff, wholeFileDiff } from '#srcblocks/analyze/filediff.js';
import { blameFile, commitDiff } from '#srcblocks/analyze/blame.js';

const include = INCLUDE.length ? INCLUDE : null;

/* Wraps an async route so a rejected promise becomes a 500 with a JSON body. */
const route = handler => (req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
        logger.error(`${req.method} ${req.originalUrl} failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    });
};

/* The query parameters every endpoint hands git as a revision. */
const REVISION_PARAMS = ['ref', 'sha', 'base', 'head', 'name'];

/*
 * The first revision parameter git would not read as a revision, if any: one
 * given twice (which arrives as an array), or one starting with `-`, which git
 * reads as an option - `--output=<file>` in place of a ref writes that file.
 *
 * `path` needs no such check: it only ever reaches git after `--` or behind a
 * revision, as `<ref>:<path>`, and neither can be read as an option.
 */
export function unsafeRevisionParam(query) {
    return REVISION_PARAMS.find(key => {
        const value = query[key];
        return value !== undefined && (typeof value !== 'string' || value.startsWith('-'));
    });
}

const rejectUnsafeRevisions = (req, res, next) => {
    const key = unsafeRevisionParam(req.query);
    if (key) {
        res.status(400).json({ error: `${key} must be a single revision name, not starting with -` });
        return;
    }
    next();
};

export function registerEndpoints(app) {
    app.use('/api', rejectUnsafeRevisions);

    app.get(
        '/api/repo',
        route(async (_req, res) => {
            if (!(await isGitRepo(REPO_DIR))) {
                res.status(400).json({ error: `${REPO_DIR} is not a git repository` });
                return;
            }
            res.json({
                repoDir: REPO_DIR,
                include,
                defaultBranch: await defaultBranch(REPO_DIR),
                branches: await listBranches(REPO_DIR),
            });
        }),
    );

    /* The call graph of one revision, with no diff information. */
    app.get(
        '/api/graph',
        route(async (req, res) => {
            const ref = req.query.ref || (await defaultBranch(REPO_DIR));
            const started = Date.now();
            const graph = await graphForRev(REPO_DIR, ref, { include });
            logger.info(`graph ${ref}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`, {
                ms: Date.now() - started,
            });
            res.json({ ref, sha: await resolveRef(REPO_DIR, ref), ...graph });
        }),
    );

    /*
     * One file, whole, at a revision - as its lines, or with `base`, as every
     * line of its own diff against that revision. The window that reads a file
     * wants one or the other, never a hunk out of the middle of it.
     */
    app.get(
        '/api/file',
        route(async (req, res) => {
            const { path, ref, base } = req.query;
            if (!path || !ref) {
                res.status(400).json({ error: 'path and ref query parameters are required' });
                return;
            }

            const file = base ? await wholeFileDiff(REPO_DIR, path, base, ref) : await fileAt(REPO_DIR, ref, path);
            if (!file) {
                res.status(404).json({ error: `${path} does not exist at ${ref}` });
                return;
            }
            res.json({ ...file, ref });
        }),
    );

    /* Which commit last touched each line of a file at a revision. */
    app.get(
        '/api/blame',
        route(async (req, res) => {
            const { path, ref } = req.query;
            if (!path || !ref) {
                res.status(400).json({ error: 'path and ref query parameters are required' });
                return;
            }
            res.json(await blameFile(REPO_DIR, ref, path));
        }),
    );

    /* One commit: its message, and its diff. */
    app.get(
        '/api/commit',
        route(async (req, res) => {
            const { sha } = req.query;
            if (!sha) {
                res.status(400).json({ error: 'sha query parameter is required' });
                return;
            }
            res.json(await commitDiff(REPO_DIR, sha));
        }),
    );

    /* One file's own diff between two revisions, hunks and all. */
    app.get(
        '/api/file-diff',
        route(async (req, res) => {
            const { path, base, head } = req.query;
            if (!path || !base || !head) {
                res.status(400).json({ error: 'path, base and head query parameters are required' });
                return;
            }
            res.json(await fileDiff(REPO_DIR, path, base, head));
        }),
    );

    /*
     * A branch's union graph plus one diff per commit on it, measured against
     * origin/main, or the branch it is stacked on, unless another base is asked
     * for - a branch stacked on another should show its own work, not the
     * whole stack's.
     */
    app.get(
        '/api/branch',
        route(async (req, res) => {
            const branch = req.query.name;
            if (!branch) {
                res.status(400).json({ error: 'name query parameter is required' });
                return;
            }
            const started = Date.now();
            const bases = await baseCandidates(REPO_DIR, branch);
            const baseRef = req.query.base || (await defaultBase(REPO_DIR, branch, bases));

            const analysis = await analyzeBranch({ repoDir: REPO_DIR, branch, baseRef, include });
            logger.info(`branch ${branch} on ${baseRef}: ${analysis.commits.length} commits`, {
                ms: Date.now() - started,
            });
            res.json({ ...analysis, bases });
        }),
    );
}
