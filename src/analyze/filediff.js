import { git } from '#srcblocks/git/repo.js';
import { diffLines } from '../app/public/diff-lines.js';

const CONTEXT = 3;

/*
 * The diff of one file between two revisions, as hunks in the usual shape:
 * changed lines with a few lines of context around them, runs of untouched
 * source in between left out.
 *
 * A file's own diff is the only way to see what changed outside the things the
 * graph knows about - an import, a top-level call, a comment between two
 * functions. Those changes are real and the canvas cannot show them.
 */
export async function fileDiff(repoDir, path, baseRef, headRef) {
    const diff = await compare(repoDir, path, baseRef, headRef);
    if (!diff) {
        return { path, status: null, hunks: [] };
    }
    return { path, status: diff.status, hunks: hunksOf(diff.rows, diff.status) };
}

/*
 * The same diff unhunked: every line of the file, with what changed in place.
 *
 * A reader who opened the whole file came for what surrounds a change, and the
 * hunked form is exactly what leaves that out.
 */
export async function wholeFileDiff(repoDir, path, baseRef, headRef) {
    const diff = await compare(repoDir, path, baseRef, headRef);
    if (!diff) {
        return null;
    }
    return { path, ...diff };
}

/*
 * A file at two revisions, diffed: what happened to it, and its lines. Null
 * when it exists at neither, which is not a diff but a bad path.
 *
 * A file that reads the same at both is untouched rather than changed, however
 * much happened around it; a reader is told what the branch did to this file,
 * and for most files the answer is nothing.
 *
 * `numbering` is the side the rows are counted down, which is the side that has
 * a line on every row: the head, unless the file is gone there.
 */
async function compare(repoDir, path, baseRef, headRef) {
    const [before, after] = await Promise.all([readFile(repoDir, baseRef, path), readFile(repoDir, headRef, path)]);
    if (before === null && after === null) {
        return null;
    }

    const rows = diffLines(before ?? '', after ?? '');
    const status = statusOf(before, after, rows);
    return { status, numbering: status === 'removed' ? 'removed' : 'added', rows };
}

const statusOf = (before, after, rows) => {
    if (before === null) {
        return 'added';
    }
    if (after === null) {
        return 'removed';
    }
    return rows.some(row => row.type !== 'context') ? 'changed' : null;
};

/* One file, whole, as it stands at a revision - what the file window reads. */
export async function fileAt(repoDir, ref, path) {
    const code = await readFile(repoDir, ref, path);
    if (code === null) {
        return null;
    }
    return { path, ref, code };
}

/* The file at a revision, or null when it did not exist there. */
async function readFile(repoDir, ref, path) {
    try {
        return await git(repoDir, ['show', '--end-of-options', `${ref}:${path}`]);
    } catch {
        return null;
    }
}

/*
 * Groups changed lines into hunks, keeping `CONTEXT` untouched lines on either
 * side and merging hunks that would otherwise overlap.
 */
function hunksOf(rows, status) {
    const changed = rows.map(row => row.type !== 'context');
    if (!changed.some(Boolean)) {
        return [];
    }

    const ranges = [];
    for (const [index, isChanged] of changed.entries()) {
        if (!isChanged) {
            continue;
        }
        const from = Math.max(0, index - CONTEXT);
        const to = Math.min(rows.length - 1, index + CONTEXT);
        const last = ranges[ranges.length - 1];
        if (last && from <= last.to + 1) {
            last.to = Math.max(last.to, to);
        } else {
            ranges.push({ from, to });
        }
    }

    // Which side of the diff the line numbers count down. Both sides are
    // counted regardless: a line is blamed at the revision that still has it,
    // which for a removed line is the one before.
    const numbering = status === 'removed' ? 'removed' : 'added';

    const at = { added: 1, removed: 1 };
    const advance = type => {
        if (type !== 'removed') {
            at.added += 1;
        }
        if (type !== 'added') {
            at.removed += 1;
        }
    };

    let cursor = 0;
    return ranges.map(range => {
        for (; cursor < range.from; cursor += 1) {
            advance(rows[cursor].type);
        }
        const from = at[numbering];
        const fromBase = at.removed;
        for (; cursor <= range.to; cursor += 1) {
            advance(rows[cursor].type);
        }
        return { from, fromBase, numbering, rows: rows.slice(range.from, range.to + 1) };
    });
}
