import { git, resolveRef } from '#srcblocks/git/repo.js';
import { cachedJson } from '#srcblocks/lib/cache.js';
import { fileDiff } from '#srcblocks/analyze/filediff.js';

/*
 * Which commit last touched each line of a file, and what those commits say.
 *
 * The answer to "why is this line like this" is usually in the message of the
 * commit that wrote it, so a diff is worth little without a way back to them.
 * Cached by the blob being blamed, which never changes.
 */
export async function blameFile(repoDir, ref, path) {
    // A file the revision never had - one side of an added or removed file -
    // has nothing to blame, which is an answer rather than a failure. Without
    // `--verify`, rev-parse echoes a ref that starts with `-` back unresolved.
    const blob = await git(repoDir, ['rev-parse', '--verify', `${ref}:${path}`]).then(
        text => text.trim(),
        () => null,
    );
    if (!blob) {
        return { lines: {}, commits: {} };
    }

    return cachedJson('blame', blob, async () => {
        const porcelain = await git(repoDir, ['blame', '--porcelain', ref, '--', path]);
        return parseBlame(porcelain);
    });
}

/*
 * Porcelain blame repeats a header per line - `<sha> <old> <new> [count]` - and
 * describes each commit once, the first time it appears.
 */
export function parseBlame(porcelain) {
    const lines = {};
    const commits = {};
    let current = null;

    for (const row of porcelain.split('\n')) {
        const header = row.match(/^([0-9a-f]{40}) \d+ (\d+)/);
        if (header) {
            current = header[1];
            lines[Number(header[2])] = current;
            if (!commits[current]) {
                commits[current] = { sha: current, shortSha: current.slice(0, 7) };
            }
            continue;
        }
        if (!current) {
            continue;
        }

        const [, field, value] = row.match(/^([a-z-]+) (.*)$/) || [];
        if (field === 'summary') {
            commits[current].subject = value;
        }
        if (field === 'author') {
            commits[current].author = value;
        }
        if (field === 'author-time') {
            commits[current].date = new Date(Number(value) * 1000).toISOString();
        }
    }

    return { lines, commits };
}

/* One commit: what it says, and what it did to each file it touched. */
export async function commitDiff(repoDir, sha) {
    const format = ['%H', '%h', '%an', '%aI', '%s', '%b'].join('\x1f');
    const [described, names] = await Promise.all([
        git(repoDir, ['show', '--no-patch', `--format=${format}`, '--end-of-options', sha]),
        git(repoDir, ['show', '--first-parent', '--name-only', '--format=', '--end-of-options', sha]),
    ]);

    const [fullSha, shortSha, author, date, subject, body] = described.trim().split('\x1f');
    const paths = names.split('\n').filter(Boolean);
    const parent = await resolveRef(repoDir, `${sha}^`).catch(() => null);

    const files = parent
        ? await Promise.all(paths.map(path => fileDiff(repoDir, path, parent, sha)))
        : paths.map(path => ({ path, status: 'added', hunks: [] }));

    return {
        sha: fullSha,
        shortSha,
        parent,
        author,
        date,
        subject,
        body: (body || '').trim(),
        files: files.filter(file => file.hunks.length),
    };
}
