import { collectApiChanges, countByType, createMatcher, searchNodes, sourceOf } from './model.js';
import { createChangesWindow } from './changes.js';
import { createSearchWindow } from './search.js';
import { isOpen, toggleMembership } from './shell.js';

/*
 * The buttons along the top, and the two windows only they open: what the branch
 * did to declarations, and what a search found.
 *
 * Both windows answer a question about the whole view rather than about one
 * node, and both are asked from the toolbar, so they are built where they are
 * asked from. They replace each other, since the reader is looking at one list.
 */
export function createToolbar({
    state,
    elements,
    reportError,
    navigateTo,
    jumpTo,
    render,
    focusChanges,
    setAllContainers,
    viewportControls,
    diffViews,
    fileView,
}) {
    const changesWindow = createChangesWindow({
        root: elements.changesWindow,
        title: elements.changesTitle,
        filters: elements.changesFilters,
        list: elements.changesList,
        close: elements.changesClose,
        // Each item is a fresh starting point, not a step on from the last one.
        onJump: id => navigateTo(id, null, { fresh: true }).catch(reportError),
        onToggleKind: type => {
            toggleMembership(state.hiddenKinds, type);
            showApiChanges();
        },
    });

    /* What the selected commits do to interfaces and data structures. */
    function showApiChanges() {
        if (!state.analysis || !state.lastView) {
            return;
        }
        searchWindow.hide();
        const items = collectApiChanges(state.index, state.lastView, node => sourceOf(node, state.selectedCommits));
        changesWindow.show(items, countByType(items), state.hiddenKinds);
    }

    const searchWindow = createSearchWindow({
        root: elements.searchWindow,
        title: elements.searchTitle,
        list: elements.searchResults,
        close: elements.searchClose,
        onJump: id => jumpTo(id).catch(reportError),
    });

    /* Searches names, paths and the source of every function on the canvas. */
    function runSearch(event) {
        event.preventDefault();
        if (!state.index || !state.lastView) {
            return;
        }

        const query = elements.searchInput.value;
        const matcher = createMatcher(query, { regex: elements.searchRegex.checked });
        if (!matcher) {
            searchWindow.hide();
            return;
        }
        if (matcher.error) {
            searchWindow.error(`That regular expression does not compile: ${matcher.error}`);
            return;
        }
        changesWindow.hide();
        searchWindow.show(
            searchNodes(state.index, state.lastView, matcher, node => sourceOf(node, state.selectedCommits)),
            query.trim(),
        );
    }

    // Escape dismisses the diff, which is something being read and then done with.
    // The calls list, the search results and the change list are how the reader
    // moves around: they stay until they are closed or replaced.
    window.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }
        diffViews.hide();
        fileView.hide();
    });

    elements.searchForm.addEventListener('submit', runSearch);
    // The toolbar buttons toggle: the same click that opened a window closes it.
    elements.viewDiff.addEventListener('click', () => {
        if (diffViews.isShowing()) {
            diffViews.hide();
        } else {
            diffViews.showDiff().catch(reportError);
        }
    });
    elements.viewDeclarations.addEventListener('click', () => {
        if (isOpen(elements.changesWindow)) {
            changesWindow.hide();
        } else {
            showApiChanges();
        }
    });
    elements.focusChanges.addEventListener('click', focusChanges);
    elements.changesOnly.addEventListener('click', () => {
        state.changesOnly = !state.changesOnly;
        state.revealed = new Set();
        elements.changesOnly.setAttribute('aria-pressed', String(state.changesOnly));
        render({ fit: true });
    });
    // Closes every open source without touching which containers are open: the
    // tree stays where the reader put it, only the code folds away.
    elements.collapseSources.addEventListener('click', () => {
        if (!state.openSources.size) {
            return;
        }
        state.openSources = new Set();
        render();
    });
    elements.expandAll.addEventListener('click', () => setAllContainers(true));
    elements.collapseAll.addEventListener('click', () => setAllContainers(false));
    elements.fitView.addEventListener('click', () => {
        if (state.lastLayout) {
            viewportControls.fit(state.lastLayout.width, state.lastLayout.height);
        }
    });
    // The whole canvas narrowed to its public interfaces, or opened back up -
    // over whatever was set for any one module or file.
    elements.exportsOnly.addEventListener('click', () => {
        state.exportsOnly = !state.exportsOnly;
        state.exportOverrides.clear();
        elements.exportsOnly.setAttribute('aria-pressed', String(state.exportsOnly));
        render({ fit: true });
    });

    return { hideChanges: () => changesWindow.hide() };
}
