import { blameSide, createBlame } from './blame.js';
import { collectDiffHunks, displayName, isLeaf, sourceOf } from './model.js';
import { createDiffWindow } from './diffwindow.js';
import { getJson, isOpen } from './shell.js';

/*
 * Everything that answers "what did the branch do to this, in lines": the whole
 * diff, one node's diff, and one commit on its own.
 *
 * They share a window, because they are the same question asked about
 * differently sized things, and they share blame, because every one of them
 * draws lines that somebody wrote for a reason.
 */
export function createDiffViews({
    state,
    elements,
    reportError,
    navigateTo,
    hideMenu,
    render,
    reopenFile,
    fileHolding,
}) {
    /*
     * The commit behind a changed line - the one whose message says why.
     *
     * A line is blamed at the revision its code was taken from, so its
     * numbering is the numbering the view draws. Answers arrive after the draw
     * that asked for them, and bring the next one with them.
     */
    const blame = createBlame({
        fetch: (path, ref) => getJson(`/api/blame?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`),
        onLoaded: () => redrawForBlame(),
    });

    /*
     * A line is blamed at the revision that still has it: a new line at the one
     * that wrote it, a removed line at the base, which is the last revision it
     * existed in.
     */
    const blameSides = (path, sha) => ({
        added: blame.of(path, sha),
        removed: state.analysis ? blame.of(path, state.analysis.base.sha) : null,
    });

    let blameRedraw = null;
    function redrawForBlame() {
        if (blameRedraw) {
            return;
        }
        blameRedraw = requestAnimationFrame(() => {
            blameRedraw = null;
            render();
            reopenFile();
        });
    }

    const diffWindow = createDiffWindow({
        root: elements.diffWindow,
        title: elements.diffTitle,
        body: elements.diffBody,
        close: elements.diffClose,
        onJump: id => navigateTo(id, null).catch(reportError),
    });

    /*
     * One node's diff, in the same window the whole diff opens in.
     *
     * For a function or a constant that is its own hunk. For a file or a module
     * it is the diff of the files themselves, which is the only way to see what
     * changed outside the declarations the graph knows about - an import, a
     * top-level call, a comment between two functions.
     */
    async function showDiffFor(node) {
        if (!state.analysis || !state.lastView) {
            return;
        }
        hideMenu();

        if (isLeaf(node)) {
            const belongs = hunk => hunk.node.id === node.id;
            const files = collectDiffHunks(state.index, state.lastView, target =>
                sourceOf(target, state.selectedCommits),
            )
                .map(file => ({ ...file, hunks: file.hunks.filter(belongs) }))
                .filter(file => file.hunks.length);
            const hunks = files.reduce((total, file) => total + file.hunks.length, 0);
            diffWindow.show(
                await withBlame(files),
                `${displayName(node)} · ${hunks} ${hunks === 1 ? 'hunk' : 'hunks'}`,
            );
            return;
        }

        const nodes = touchedFilesUnder(node.id);
        diffWindow.show([], `${node.name} · reading ${nodes.length} ${nodes.length === 1 ? 'file' : 'files'}…`);

        const head = newestSelectedCommit() || state.analysis.base.sha;
        const diffs = await Promise.all(
            nodes.map(file =>
                getJson(
                    `/api/file-diff?path=${encodeURIComponent(file.file)}&base=${encodeURIComponent(state.analysis.base.sha)}&head=${encodeURIComponent(head)}`,
                ).then(diff => ({
                    file: file.file,
                    hunks: diff.hunks.map(hunk =>
                        asHunk(hunk, { node: file, path: file.file, sha: head }, diff.status),
                    ),
                })),
            ),
        );

        const shown = diffs.filter(diff => diff.hunks.length);
        const hunks = shown.reduce((total, diff) => total + diff.hunks.length, 0);
        diffWindow.show(
            await withBlame(shown),
            `${node.name} · ${hunks} ${hunks === 1 ? 'hunk' : 'hunks'} in ${shown.length} ${shown.length === 1 ? 'file' : 'files'}`,
        );
    }

    /*
     * The touched files a container holds - or the file itself, if it is one, or
     * the file it lives in.
     *
     * A class is not above its file but inside it: what it holds is methods, so
     * walking down from one finds no file at all, and its diff came back empty
     * however much its own methods had changed.
     */
    function touchedFilesUnder(id) {
        const node = state.index.nodes.get(id);
        if (node?.kind === 'file') {
            return [node];
        }
        if (node?.kind === 'group') {
            const file = fileHolding(node);
            return file ? [file] : [];
        }

        const found = [];
        const walk = current => {
            for (const child of state.index.children.get(current) || []) {
                if (!state.lastView.present.has(child.id)) {
                    continue;
                }
                if (child.kind === 'file') {
                    if (state.lastView.status.has(child.id)) {
                        found.push(child);
                    }
                } else {
                    walk(child.id);
                }
            }
        };
        walk(id);
        return found.sort((a, b) => a.file.localeCompare(b.file));
    }

    /* The last of the selected commits to touch anything, if a branch is loaded. */
    const newestSelectedCommit = () =>
        (state.analysis
            ? [...state.analysis.commits].reverse().find(commit => state.selectedCommits.has(commit.sha))?.sha
            : null) || null;

    /* A file's hunk, in the shape the diff window draws. */
    const asHunk = (hunk, { node = null, path, sha = null }, status) => ({
        node,
        file: path,
        sha,
        fromBase: hunk.fromBase ?? null,
        label: `lines ${hunk.from}…`,
        status: status || 'changed',
        rows: hunk.rows,
        from: hunk.from,
        numbering: hunk.numbering,
        added: hunk.rows.filter(row => row.type === 'added').length,
        removed: hunk.rows.filter(row => row.type === 'removed').length,
    });

    /* Every hunk drawn beside the commit that wrote each of its lines. */
    async function withBlame(files) {
        const baseSha = state.analysis?.base.sha || null;
        await blame.load(
            files.flatMap(file => [
                ...file.hunks.map(hunk => ({ path: file.file, ref: hunk.sha })),
                { path: file.file, ref: baseSha },
            ]),
        );

        return files.map(file => ({
            ...file,
            hunks: file.hunks.map(hunk => ({
                ...hunk,
                file: file.file,
                blame: sidesOf(hunk, blame.of(file.file, hunk.sha), blame.of(file.file, baseSha)),
            })),
        }));
    }

    /* Where each side of a hunk starts, paired with the blame that answers for it. */
    const sidesOf = (hunk, added, removed) => ({
        added: blameSide(hunk.numbering === 'added' ? hunk.from : null, added),
        removed: blameSide(hunk.numbering === 'removed' ? hunk.from : hunk.fromBase, removed),
    });

    /*
     * One commit on its own: what it says, and what it did.
     *
     * This is where a blame link leads, and the reason for the whole detour -
     * the message is usually the answer to "why was this change made?".
     */
    async function showCommit(sha) {
        diffWindow.show([], `${sha.slice(0, 7)} · reading commit…`, { empty: '' });
        const commit = await getJson(`/api/commit?sha=${encodeURIComponent(sha)}`);
        await blame.load(commit.files.map(file => ({ path: file.path, ref: commit.parent })));

        // The new lines here are this commit's own, so only the removed ones are
        // worth a link: they came from somewhere, and that is the question.
        const files = commit.files.map(file => ({
            file: file.path,
            hunks: file.hunks.map(hunk => ({
                ...asHunk(hunk, { node: fileNodeFor(file.path), path: file.path }, file.status),
                blame: sidesOf(hunk, null, blame.of(file.path, commit.parent)),
            })),
        }));

        diffWindow.show(files, `${commit.shortSha} · ${commit.subject}`, {
            note: commit.body || null,
            empty: 'This commit changed no text.',
        });
    }

    /* The canvas node for a path, so a commit's files stay a click from the graph. */
    function fileNodeFor(path) {
        for (const node of state.index.nodes.values()) {
            if (node.kind === 'file' && node.file === path) {
                return node;
            }
        }
        return null;
    }

    /* Everything the selected commits changed, function by function. */
    async function showDiff() {
        if (!state.analysis || !state.lastView) {
            return;
        }
        const files = collectDiffHunks(state.index, state.lastView, node => sourceOf(node, state.selectedCommits));
        const hunks = files.reduce((total, file) => total + file.hunks.length, 0);
        diffWindow.show(
            await withBlame(files),
            `${state.analysis.head.ref} · ${state.selectedCommits.size} of ${state.analysis.commits.length} commits · ${hunks} functions in ${files.length} files`,
        );
    }

    /*
     * A blame link is a link out of whatever is showing it, so it is caught
     * before the node, window or canvas under it can treat the click as its own.
     */
    document.addEventListener(
        'click',
        event => {
            const chip = event.target.closest?.('.code-blame');
            if (!chip) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            showCommit(chip.dataset.sha).catch(reportError);
        },
        true,
    );

    return {
        blame,
        blameSides,
        newestSelectedCommit,
        showDiff,
        showDiffFor,
        hide: () => diffWindow.hide(),
        isShowing: () => isOpen(elements.diffWindow),
    };
}
