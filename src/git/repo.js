import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

export async function git(repoDir, args) {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}

export async function isGitRepo(repoDir) {
    try {
        await git(repoDir, ['rev-parse', '--git-dir']);
        return true;
    } catch {
        return false;
    }
}

export const resolveRef = async (repoDir, ref) => (await git(repoDir, ['rev-parse', ref])).trim();

export const treeSha = async (repoDir, ref) => (await git(repoDir, ['rev-parse', `${ref}^{tree}`])).trim();

export const mergeBase = async (repoDir, a, b) => (await git(repoDir, ['merge-base', a, b])).trim();

/* `main` and `origin/main` are one branch, under the name the local ref has. */
const shortNameOf = name => name.replace(/^origin\//, '');

/*
 * All local and remote branches, with remote duplicates of a local branch
 * removed and the refs that only point at a branch left out. The default
 * branch (origin/HEAD, else main/master) is flagged.
 */
export async function listBranches(repoDir) {
    // The symbolic ref leads, ahead of the free-form subject.
    const format = ['%(symref)', '%(refname:short)', '%(objectname)', '%(committerdate:iso-strict)', '%(subject)'].join(
        FIELD_SEP,
    );
    const stdout = await git(repoDir, [
        'for-each-ref',
        '--sort=-committerdate',
        `--format=${format}`,
        'refs/heads',
        'refs/remotes',
    ]);
    const fallback = await defaultBranch(repoDir);

    const seen = new Set();
    const branches = [];
    for (const line of stdout.split('\n').filter(Boolean)) {
        const [symref, name, sha, date, subject] = line.split(FIELD_SEP);
        // `origin/HEAD` is no branch, only a pointer at one. Its name does not
        // give it away either: shortened, it reads as plain `origin`.
        if (symref) {
            continue;
        }
        const shortName = shortNameOf(name);
        if (seen.has(shortName)) {
            continue;
        }
        seen.add(shortName);
        branches.push({ name, shortName, sha, date, subject, isDefault: shortName === shortNameOf(fallback) });
    }

    return branches;
}

export async function defaultBranch(repoDir) {
    try {
        const head = (await git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
        if (head) {
            return head;
        }
    } catch {
        // No origin/HEAD; fall through to the usual local names.
    }
    for (const candidate of ['main', 'master', 'origin/main', 'origin/master']) {
        try {
            await resolveRef(repoDir, candidate);
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }
    return 'HEAD';
}

/*
 * Commits reachable from `headRef` but not `baseRef`, oldest first.
 *
 * Merge commits are skipped: measured against its first parent, a merge reports
 * everything the other side brought as its own work. What that side actually
 * did is in its own commits, and those are listed whenever the base does not
 * already have them - which is what lets a base further down a stack deepen the
 * list rather than reporting the same handful of commits from every base.
 *
 * Each commit records its first parent, which is what its changes are measured
 * against.
 */
export async function listCommits(repoDir, baseRef, headRef) {
    // The body comes last: it is the one field that can run to many lines.
    const format = ['%H', '%h', '%an', '%aI', '%P', '%s', '%b'].join(FIELD_SEP) + RECORD_SEP;
    const stdout = await git(repoDir, [
        'log',
        '--no-merges',
        '--reverse',
        `--format=${format}`,
        `${baseRef}..${headRef}`,
    ]);

    return stdout
        .split(RECORD_SEP)
        .map(record => record.trim())
        .filter(Boolean)
        .map(record => {
            const [sha, shortSha, author, date, parents, subject, body] = record.split(FIELD_SEP);
            return { sha, shortSha, author, date, subject, body: (body || '').trim(), parent: parents.split(' ')[0] };
        });
}

/*
 * What a branch could sensibly be compared against, closest first.
 *
 * Every other branch is a candidate, and the only thing that rules one out is
 * having nothing to show: that is, the branch holding no commit the candidate
 * does not already have. There is deliberately no cleverer test than that. A
 * branch stacked on another, a long-lived branch main has run ahead of, and the
 * deploy branch behind them both all ask the same question - what does this
 * branch have that that one does not - and only how far off the answer is tells
 * them apart, which is what the ordering is for.
 *
 * Distance is counted both ways, though only one of the two numbers is the size
 * of the diff. A branch this one is simply ahead of comes first, nearest first,
 * and a branch that has since gone its own way comes after - because its own
 * work lands in the diff as removals that were never this branch's doing, and
 * that is a worse diff to read than a longer one. What a branch was built on is
 * something it is simply ahead of, so a stack still reads bottom-up.
 */
export async function baseCandidates(repoDir, branch) {
    const named = shortNameOf(branch);
    const others = (await listBranches(repoDir)).filter(other => other.shortName !== named);

    // Counted the way the commits are listed, so the number beside a candidate
    // is what choosing it will show. That is one git call per branch, so they
    // are asked all at once rather than one after another.
    const counted = await Promise.all(others.map(other => distance(repoDir, other.name, branch)));

    return counted
        .filter(candidate => candidate.commits > 0)
        .sort((a, b) => a.theirs - b.theirs || a.commits - b.commits);
}

/*
 * What a branch is read against until another base is asked for: the remote
 * copy of the default branch, unless the branch is stacked on another - a
 * branch whose tip sits between this one and where it left main, which is the
 * nearest such branch. Anything else, however near, is no default: a branch
 * main has run past is a diff full of main's own work.
 *
 * `candidates` are what `baseCandidates` found for the branch.
 */
export async function defaultBase(repoDir, branch, candidates) {
    const main = await mainline(repoDir);
    // Main has nothing to be read against but what it is ahead of.
    if (shortNameOf(branch) === shortNameOf(main)) {
        return candidates[0]?.name ?? main;
    }

    // Candidates come nearest first, and only one this branch is simply ahead
    // of can be below it in a stack.
    const below = candidates.filter(
        candidate => candidate.theirs === 0 && shortNameOf(candidate.name) !== shortNameOf(main),
    );
    const stacked = await Promise.all(
        below.map(
            async candidate =>
                (await isAncestor(repoDir, candidate.name, branch)) &&
                !(await isAncestor(repoDir, candidate.name, main)),
        ),
    );
    return below.find((_, index) => stacked[index])?.name ?? main;
}

/* The default branch as the remote has it, if there is a remote copy. */
async function mainline(repoDir) {
    const local = await defaultBranch(repoDir);
    const remote = `origin/${shortNameOf(local)}`;
    try {
        await resolveRef(repoDir, remote);
        return remote;
    } catch {
        return local;
    }
}

async function isAncestor(repoDir, ancestor, descendant) {
    try {
        await git(repoDir, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
}

/* How far two branches stand apart: what each holds that the other does not. */
async function distance(repoDir, base, branch) {
    const counts = await git(repoDir, ['rev-list', '--left-right', '--count', '--no-merges', `${base}...${branch}`]);
    const [theirs, ours] = counts.trim().split(/\s+/).map(Number);
    return { name: base, commits: ours, theirs };
}

/*
 * Extracts the tree of `ref` into `destDir` without modifying the repository.
 * `--end-of-options` keeps a ref that starts with `-` from being read as an option.
 */
export async function extractTree(repoDir, ref, destDir) {
    const archive = `git -C ${quote(repoDir)} archive --format=tar --end-of-options ${quote(ref)}`;
    const command = `${archive} | tar -x -C ${quote(destDir)}`;
    await execFileAsync('sh', ['-c', command]);
}

const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
