import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { baseCandidates, defaultBase, git } from '#srcblocks/git/repo.js';

/*
 * A throwaway repository: `main` with a remote copy, and whatever branches a
 * test grows off it. Commits are empty - only the shape of history matters.
 */
async function createRepo() {
    const dir = await mkdtemp(path.join(tmpdir(), 'srcblocks-base-'));
    const run = args => git(dir, args);
    await run(['init', '-q', '-b', 'main']);
    await run(['config', 'user.email', 'test@example.com']);
    await run(['config', 'user.name', 'Test']);
    const commit = message => run(['commit', '-q', '--allow-empty', '-m', message]);
    return { dir, run, commit };
}

const chooseBase = async (dir, branch) => defaultBase(dir, branch, await baseCandidates(dir, branch));

describe('defaultBase', () => {
    let repo;
    beforeEach(async () => {
        repo = await createRepo();
        await repo.commit('m1');
    });
    afterEach(() => rm(repo.dir, { recursive: true, force: true }));

    it('reads a branch against origin/main, not an old branch behind main', async () => {
        const { run, commit } = repo;
        await run(['branch', 'deploy']);
        await commit('m2');
        await commit('m3');
        await run(['checkout', '-q', '-b', 'feature']);
        await commit('f1');
        await run(['checkout', '-q', 'main']);
        await commit('m4');
        await run(['update-ref', 'refs/remotes/origin/main', 'main']);

        expect(await chooseBase(repo.dir, 'feature')).toBe('origin/main');
    });

    it('falls back to the local default branch when there is no remote', async () => {
        const { run, commit } = repo;
        await run(['checkout', '-q', '-b', 'feature']);
        await commit('f1');

        expect(await chooseBase(repo.dir, 'feature')).toBe('main');
    });

    it('reads a stacked branch against the branch it sits on', async () => {
        const { run, commit } = repo;
        await run(['update-ref', 'refs/remotes/origin/main', 'main']);
        await run(['checkout', '-q', '-b', 'bottom']);
        await commit('b1');
        await run(['checkout', '-q', '-b', 'middle']);
        await commit('m1');
        await run(['checkout', '-q', '-b', 'top']);
        await commit('t1');

        expect(await chooseBase(repo.dir, 'top')).toBe('middle');
        expect(await chooseBase(repo.dir, 'middle')).toBe('bottom');
        expect(await chooseBase(repo.dir, 'bottom')).toBe('origin/main');
    });

    it('ignores a branch below that main already has', async () => {
        const { run, commit } = repo;
        await run(['checkout', '-q', '-b', 'merged']);
        await commit('x1');
        await run(['checkout', '-q', '-b', 'feature']);
        await commit('f1');
        await run(['checkout', '-q', 'main']);
        await run(['merge', '-q', '--ff-only', 'merged']);
        await commit('m2');
        await run(['update-ref', 'refs/remotes/origin/main', 'main']);

        expect(await chooseBase(repo.dir, 'feature')).toBe('origin/main');
    });
});
