import { createShell, getJson } from './shell.js';
import { createBranchPanel } from './branchpanel.js';
import { createCanvasView } from './canvasview.js';
import { createDefinitions } from './definitions.js';
import { createDiffViews } from './diffviews.js';
import { createFilesPanel } from './filespanel.js';
import { createFileView } from './fileview.js';
import { createHover } from './hover.js';
import { createLayout } from './layout.js';
import { createNodeMenu } from './nodemenu.js';
import { createRenderer } from './render.js';
import { createSelection } from './selection.js';
import { createTheme } from './theme.js';
import { createToolbar } from './toolbar.js';
import { createTooltip } from './tooltip.js';
import { createViewportControls } from './viewport.js';

/*
 * Where the page is put together.
 *
 * Every part of it is a factory taking what it needs and returning what others
 * need of it, which leaves them independent of each other - but not acyclic: the
 * canvas draws what the diff windows blame, and the diff windows redraw the
 * canvas. Anything reached for across such a pair is passed as a function that
 * forwards when it is called, so nothing here depends on being built first.
 */

/*
 * The page's furniture, by id. The name each one is known by here is its id in
 * camel case, so the markup and this list cannot drift apart silently: a
 * renamed id arrives as `undefined` at the module that asked for it.
 */
const elements = Object.fromEntries(
    (
        'repo-info branch-filter branch-select branch-clear base-field base-filter base-select branch-panel ' +
        'branch-summary files-summary files-expand files-collapse file-tree commits-panel commit-list commit-count ' +
        'commits-all commits-none view-diff view-declarations changes-window changes-title changes-filters ' +
        'changes-list changes-close diff-window diff-title diff-body diff-close file-window file-title file-body ' +
        'file-close expand-all collapse-all collapse-sources focus-changes changes-only fit-view exports-only status-text ' +
        'sidebar-toggle theme-select loading loading-text viewport world node-layer measure-layer edge-layer ' +
        'edge-highlight-layer calls-window calls-title calls-groups calls-dock calls-close node-menu tooltip ' +
        'search-form search-input search-regex search-window search-title search-results search-close'
    )
        .split(' ')
        .map(id => [id.replace(/-(.)/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]),
);

const state = {
    repo: null,
    branch: null,
    index: null,
    analysis: null,
    selectedCommits: new Set(),
    expanded: new Set(),
    openSources: new Set(),
    sideBySide: new Set(),
    // The maximised window's own two switches, which outlive any one node in it.
    fileView: { diff: true, split: false },
    offsets: new Map(),
    openGroups: new Set(),
    topGroup: null,
    changesOnly: false,
    hidden: new Set(),
    // Whether the canvas shows only what is exported, and the modules and files
    // the reader set otherwise since.
    exportsOnly: false,
    exportOverrides: new Map(),
    // Definitions gone to, kept on the canvas whatever it is filtered down to.
    revealed: new Set(),
    hiddenKinds: new Set(),
    lastLayout: null,
    lastView: null,
    lastUi: null,
    lastPlan: null,
};

const { setStatus, reportError, whileLoading } = createShell({
    statusText: elements.statusText,
    loading: elements.loading,
    loadingText: elements.loadingText,
    sidebarToggle: elements.sidebarToggle,
    disableWhileLoading: [elements.branchSelect, elements.baseSelect],
});

createTheme({ select: elements.themeSelect });

/* The forwarders that break the cycles: each resolves when it is called. */
const render = options => canvas.render(options);
const reopenFile = () => fileView.reopenFile();
const hideMenu = () => nodeMenu.hide();
const navigateTo = (id, from, options) => hover.navigateTo(id, from, options);
const selectionChanged = () => hover.selectionChanged();

const selection = createSelection();
const tooltip = createTooltip(elements.tooltip);
const layout = createLayout();

const renderer = createRenderer({
    nodeLayer: elements.nodeLayer,
    measureLayer: elements.measureLayer,
    edgeLayer: elements.edgeLayer,
    edgeHighlightLayer: elements.edgeHighlightLayer,
    interactions: { onToggle: node => canvas.toggleNode(node), getScale: () => viewportControls.getScale() },
});

const viewportControls = createViewportControls(elements.viewport, elements.world, {
    onBackgroundClick: () => {
        selection.click(null);
        hover.selectionChanged();
    },
});

/*
 * What a node offers, wherever its header is drawn: on the canvas the menu does
 * all of this, and a window that gives a node the whole screen puts the same
 * buttons in its own header. The canvas itself only opens and drags a node.
 */
const nodeActions = {
    onPinChange: (node, pinned) => {
        selection.setPinned(node.id, pinned);
        hover.showPinned(node.id, pinned);
        hover.selectionChanged();
    },
    onHideChange: node => canvas.toggleHidden(node),
    onExportsOnlyChange: node => canvas.toggleExportsOnly(node),
    onCopyLocation: (node, button) => fileView.copyLocation(node, button).catch(reportError),
    onShowDiff: node => diffViews.showDiffFor(node).catch(reportError),
    onToggleDiffView: node => canvas.toggleDiffView(node),
    onMaximise: node => fileView.showFile(node).catch(reportError),
};

/*
 * The hovered node's actions. They are anchored to the header as it stands on
 * screen now, so a menu left open across a redraw follows the node that moved.
 */
const nodeMenu = createNodeMenu({
    root: elements.nodeMenu,
    interactions: nodeActions,
    anchorFor: id => renderer.elementOf(id)?.querySelector('.node-header')?.getBoundingClientRect() || null,
});

const filesPanel = createFilesPanel({ state, elements, onSelect: id => hover.navigateTo(id, null).catch(reportError) });

const hover = createHover({
    state,
    elements,
    selection,
    renderer,
    viewportControls,
    nodeMenu,
    tooltip,
    render,
    reopenFile,
    reportError,
});

const canvas = createCanvasView({
    state,
    elements,
    selection,
    renderer,
    layout,
    viewportControls,
    nodeMenu,
    tooltip,
    filesPanel,
    setStatus,
    reportError,
    blameSides: (path, sha) => diffViews.blameSides(path, sha),
    applyHighlight: hover.applyHighlight,
    refreshCalls: hover.refreshCalls,
    selectionChanged: hover.selectionChanged,
    hideDiff: () => diffViews.hide(),
    hideChanges: () => toolbar.hideChanges(),
    fileView: { holds: id => fileView.holds(id), hide: () => fileView.hide() },
});

const diffViews = createDiffViews({
    state,
    elements,
    reportError,
    hideMenu,
    render,
    reopenFile,
    navigateTo: hover.navigateTo,
    fileHolding: node => fileView.fileHolding(node),
});

const fileView = createFileView({
    state,
    elements,
    setStatus,
    reportError,
    hideMenu,
    blame: diffViews.blame,
    blameSides: diffViews.blameSides,
    newestSelectedCommit: diffViews.newestSelectedCommit,
});

createDefinitions({
    state,
    root: elements.viewport,
    navigateTo: hover.navigateTo,
    showFile: fileView.showFile,
    reportError,
});

const toolbar = createToolbar({
    state,
    elements,
    reportError,
    render,
    viewportControls,
    diffViews,
    fileView,
    navigateTo: hover.navigateTo,
    jumpTo: hover.jumpTo,
    focusChanges: canvas.focusChanges,
    setAllContainers: canvas.setAllContainers,
});

const { renderBranchOptions } = createBranchPanel({
    state,
    elements,
    whileLoading,
    reportError,
    render,
    loadGraph: canvas.loadGraph,
    expandTowardsChanges: canvas.expandTowardsChanges,
});

async function init() {
    try {
        state.repo = await getJson('/api/repo');
    } catch (err) {
        setStatus(`Cannot read repository: ${err.message}`);
        return;
    }

    const include = state.repo.include ? ` (${state.repo.include.join(', ')})` : '';
    elements.repoInfo.textContent = `${state.repo.repoDir}${include}`;
    renderBranchOptions();

    const graph = await whileLoading(`Reading ${state.repo.defaultBranch}`, () =>
        getJson(`/api/graph?ref=${encodeURIComponent(state.repo.defaultBranch)}`),
    );
    canvas.loadGraph(graph, null);
    await canvas.render({ fit: true });
}

init().catch(reportError);
