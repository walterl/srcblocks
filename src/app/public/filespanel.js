import { buildFileTree, countFiles } from './model.js';
import { createFileTree } from './filetree.js';

/*
 * The sidebar's Files section: what is on the canvas as a tree of directories,
 * or with a branch loaded only the files it touched.
 *
 * It is redrawn by every render, since it describes the same view the canvas
 * does - which is why the canvas is handed a `refresh` rather than this
 * reaching into the canvas for what it drew.
 */
export function createFilesPanel({ state, elements, onSelect }) {
    const tree = createFileTree({
        root: elements.fileTree,
        onSelect,
        onFold: () => refreshFolds(),
    });

    /* The files on the canvas; with a branch loaded, the ones it touched. */
    function refresh(view) {
        const built = buildFileTree(state.index, view, { changedOnly: Boolean(state.analysis) });
        const files = countFiles(built);
        elements.filesSummary.textContent = state.analysis
            ? `${files} touched`
            : `${files} ${files === 1 ? 'file' : 'files'}`;
        tree.render(built);
    }

    /* Neither button offers to do what has already been done. */
    function refreshFolds() {
        const { canExpand, canCollapse } = tree.folds;
        elements.filesExpand.disabled = !canExpand;
        elements.filesCollapse.disabled = !canCollapse;
    }

    elements.filesExpand.addEventListener('click', () => tree.expandAll());
    elements.filesCollapse.addEventListener('click', () => tree.collapseAll());

    return { refresh };
}
