import { ancestors, isLeaf, lineRange, sourceOf, vimLocation } from './model.js';
import { copyText } from './clipboard.js';
import { createFileWindow } from './filewindow.js';
import { getJson } from './shell.js';

/*
 * The window that gives a node the whole screen: the file it lives in, whole,
 * with the node's own lines picked out.
 *
 * It also carries the one thing a reader does with a node that is not about
 * reading it here - copying where it is, for an editor.
 */
export function createFileView({
    state,
    elements,
    setStatus,
    reportError,
    hideMenu,
    blame,
    blameSides,
    newestSelectedCommit,
}) {
    const fileWindow = createFileWindow({
        root: elements.fileWindow,
        title: elements.fileTitle,
        body: elements.fileBody,
        close: elements.fileClose,
        onToggleDiff: () => {
            state.fileView.diff = !state.fileView.diff;
            reopenFile();
        },
        onToggleDiffView: () => {
            state.fileView.split = !state.fileView.split;
            reopenFile();
        },
    });

    /*
     * The line the window was opened at, when it was opened at one rather than
     * at a node's own lines: a definition that no node holds. Drawing the window
     * again keeps it.
     */
    let lineAsked = null;

    /* Draws the open window again, for a control of its own that changed it. */
    function reopenFile() {
        const node = fileWindow.nodeId && state.index.nodes.get(fileWindow.nodeId);
        if (node) {
            showFile(node, { line: lineAsked }).catch(reportError);
        }
    }

    /*
     * The file a node lives in, whole, with the node's own lines picked out.
     *
     * It is read at the revision the node is being shown at, so what the window
     * says and what the canvas says are the same code - the newest selected
     * commit that touched it, or the base revision the diff is measured from
     * once nothing is selected, or the default branch when no branch is loaded.
     * Falling back to the branch's head instead put the window a whole branch
     * ahead of the canvas whenever the reader unticked every commit.
     *
     * With a branch loaded the file arrives as its own diff, which holds both of
     * the things the window can show: the branch's work is the rows themselves,
     * and the code as it stands is those rows with the removals dropped. One
     * round trip, whichever way `DIFF` is set.
     */
    async function showFile(node, { line = null } = {}) {
        if (!node.file || !state.lastUi) {
            return;
        }
        hideMenu();
        lineAsked = line;

        const source = isLeaf(node) ? sourceOf(node, state.selectedCommits) : null;
        const ref = source?.sha || newestSelectedCommit() || state.analysis?.base.sha || state.repo.defaultBranch;
        const base = state.analysis?.base.sha || null;
        const query = `path=${encodeURIComponent(node.file)}&ref=${encodeURIComponent(ref)}`;
        const file = await getJson(`/api/file?${query}${base ? `&base=${encodeURIComponent(base)}` : ''}`);

        // Blame is a round trip of its own, and this window is built once: wait
        // for it rather than drawing the lines twice.
        if (file.rows) {
            await blame.load([
                { path: node.file, ref },
                { path: node.file, ref: base },
            ]);
        }

        // A diff is loaded whenever the file came back as one, whether or not
        // the branch went anywhere near this file: the reader still gets to ask.
        const diff = file.rows ? { rows: file.rows, status: file.status, numbering: file.numbering } : null;
        fileWindow.show({
            node,
            path: file.path,
            ref,
            code: file.rows ? headSideOf(file.rows) : file.code,
            diff,
            blame: diff ? blameSides(node.file, ref) : null,
            focus: line ? { from: line, to: line } : node.kind === 'file' ? null : lineRange(node, source),
            diffing: state.fileView.diff,
            split: state.fileView.split,
        });
    }

    /* The file as the selected commits leave it: the diff minus what they took. */
    const headSideOf = rows =>
        rows
            .filter(row => row.type !== 'removed')
            .map(row => row.text)
            .join('\n');

    /* The file node a node lives in, which for a file is itself. */
    const fileHolding = node =>
        ancestors(state.index, node.id)
            .map(id => state.index.nodes.get(id))
            .find(held => held?.kind === 'file') || null;

    /*
     * Where a node is, on the clipboard, in the form vim takes after `:edit `.
     *
     * Reading happens here and editing happens in an editor; this is the
     * shortest path between the two. The button says so for a moment, since a
     * clipboard gives no sign of having been written to.
     */
    async function copyLocation(node, button) {
        const location = vimLocation(node);
        if (!location) {
            return;
        }
        if (!(await copyText(location))) {
            setStatus(`Could not copy ${location}`);
            return;
        }

        const icon = button.querySelector('use');
        icon.setAttribute('href', '#icon-check');
        button.classList.add('copied');
        button.title = `Copied ${location}`;
        setTimeout(() => {
            icon.setAttribute('href', '#icon-copy');
            button.classList.remove('copied');
            button.title = 'Copy this location for :edit';
        }, 1200);
    }

    return {
        showFile,
        reopenFile,
        copyLocation,
        fileHolding,
        holds: id => fileWindow.nodeId === id,
        hide: () => fileWindow.hide(),
    };
}
