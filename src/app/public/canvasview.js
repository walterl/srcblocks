import {
    ancestors,
    deriveViewState,
    diffStats,
    exportsOnlyAt,
    indexGraph,
    isLeaf,
    restrictToChanges,
    restrictToExports,
    revealIn,
    sourceOf,
    totalDiffStat,
} from './model.js';
import { buildRenderPlan } from './viewmodel.js';
import { nodeDiffStat } from './nodechrome.js';
import { toggleMembership } from './shell.js';

/*
 * The canvas itself: what is drawn, when it is drawn again, and what a click on
 * a node does to it.
 *
 * A graph arriving from the server lands here too, since loading one is mostly a
 * matter of throwing away everything the last one had been opened into.
 */
export function createCanvasView({
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
    blameSides,
    applyHighlight,
    refreshCalls,
    selectionChanged,
    hideDiff,
    hideChanges,
    fileView,
}) {
    /* ---------- data loading ---------- */

    function loadGraph(graph, analysis) {
        // An arrangement worked out for one graph says nothing about the next.
        layout.reset();
        hideDiff();
        hideChanges();
        state.hiddenKinds = new Set();
        for (const button of [
            elements.focusChanges,
            elements.changesOnly,
            elements.viewDiff,
            elements.viewDeclarations,
        ]) {
            button.disabled = !analysis;
        }
        // Every filter starts over with the graph it filters.
        state.changesOnly = false;
        elements.changesOnly.setAttribute('aria-pressed', 'false');
        state.exportsOnly = false;
        elements.exportsOnly.setAttribute('aria-pressed', 'false');
        state.index = indexGraph(graph);
        state.analysis = analysis;
        state.selectedCommits = new Set();
        state.openSources = new Set();
        selection.clear();
        state.openGroups = new Set();
        state.topGroup = null;
        state.sideBySide = new Set();
        state.hidden = new Set();
        state.exportOverrides = new Map();
        state.revealed = new Set();
        state.offsets = new Map();
        // Only the outermost modules start open: the first view is the shape of
        // the tree, and detail is opened on demand (or by a diff, see
        // expandTowardsChanges).
        state.expanded = new Set(state.index.roots.filter(node => node.kind === 'module').map(node => node.id));
    }

    /*
     * Back to the view a branch opens with: everything closed except what the
     * selected commits touch. Worth a button of its own, since ticking commits
     * changes what that is.
     */
    function focusChanges() {
        if (!state.analysis) {
            return;
        }
        state.expanded = new Set();
        expandTowardsChanges();
        render({ fit: true });
    }

    /* Opens every container that holds a change, so a diff is visible immediately. */
    function expandTowardsChanges() {
        const view = deriveViewState(state.index, state.analysis, state.selectedCommits, state.hidden);
        for (const id of view.status.keys()) {
            for (const ancestor of ancestors(state.index, id)) {
                state.expanded.add(ancestor);
            }
        }
    }

    /* ---------- rendering ---------- */

    /*
     * Renders are serialised: a click during a layout would otherwise rebuild
     * the node elements while the previous pass is still placing them.
     */
    let pending = Promise.resolve();

    function render(options) {
        pending = pending.then(() => renderOnce(options)).catch(reportError);
        return pending;
    }

    async function renderOnce({ fit = false, keepInPlace = null } = {}) {
        if (!state.index) {
            return;
        }

        const full = deriveViewState(state.index, state.analysis, state.selectedCommits, state.hidden);
        const { plan, view } = callsPlan(full);
        const ui = {
            view,
            openSources: state.openSources,
            hasDiff: Boolean(state.analysis),
            // What the branch did to each node, in lines, for its header.
            diffStats: state.analysis
                ? diffStats(state.index, view, node => sourceOf(node, state.selectedCommits))
                : null,
            isPinned: id => selection.isPinned(id),
            sideBySide: state.sideBySide,
            exportsOnlyAt: id => exportsOnlyAt(state.index, id, exportSettings()),
            exportOverrides: state.exportOverrides,
            offsets: state.offsets,
            selected: state.selectedCommits,
            blameSides,
        };
        const prepared = renderer.prepare(plan, ui);

        const placement = layout.run(plan, id => prepared.sizes.get(id));
        renderer.commit(prepared, plan, placement, ui);
        tooltip.hide();
        state.lastLayout = placement;
        state.lastView = view;
        state.lastPlan = plan;
        state.lastUi = ui;
        // A menu open over the node that was just redrawn moves with it.
        nodeMenu.refresh(ui);
        elements.collapseSources.disabled = state.openSources.size === 0;
        filesPanel.refresh(view);
        applyHighlight();
        refreshCalls();

        if (fit) {
            viewportControls.fit(layout.width, layout.height);
        }
        if (keepInPlace) {
            restorePosition(keepInPlace);
        }
        setStatus(...summary(plan, ui));
    }

    function callsPlan(full) {
        const changed = state.changesOnly && state.analysis ? restrictToChanges(state.index, full) : full;
        const filtered =
            state.exportsOnly || state.exportOverrides.size
                ? restrictToExports(state.index, changed, exportSettings(), state.selectedCommits)
                : changed;
        const view = revealIn(state.index, filtered, state.revealed);
        return { view, plan: buildRenderPlan(state.index, view, state.expanded) };
    }

    function summary(plan, ui) {
        const parts = [];
        if (state.analysis) {
            const { base, head, commits } = state.analysis;
            const { added, removed } = totalDiffStat(state.index, ui.diffStats);
            parts.push(`${head.ref} vs ${base.ref}@${base.sha.slice(0, 7)}`);
            // How much there is to read, beside what it is being read against. A
            // node says this for itself; on a diff of a hundred commits the total
            // is the thing there is no other way to see - and it is the same
            // diffstat as a node's, so it is drawn by the same hand.
            parts.push(nodeDiffStat({ added, removed }));
            parts.push(`${state.selectedCommits.size}/${commits.length} commits`);
        } else {
            parts.push(state.repo.defaultBranch);
        }
        parts.push(`${plan.drawn.length} nodes, ${plan.edges.length} edges drawn`);
        if (state.hidden.size) {
            parts.push(`${state.hidden.size} hidden`);
        }
        return parts;
    }

    /* ---------- interaction ---------- */

    /*
     * Clicking a node opens or closes it, and selects it: a function becomes the
     * one whose calls are listed, and clicking anything else ends that selection.
     */
    /*
     * Takes a node off the canvas, or brings it back.
     *
     * A hidden node is drawn shut and left otherwise as it was found, so it comes
     * back the way the reader left it. What it does lose is the canvas's attention:
     * a pin or a selection inside it would keep pointing at something the reader
     * has just said they are not interested in.
     */
    function toggleHidden(node) {
        if (state.hidden.has(node.id)) {
            state.hidden.delete(node.id);
            render();
            return;
        }

        state.hidden.add(node.id);
        dropSelection(node.id);
        selection.hover(null);
        selectionChanged();
        render();
    }

    /* Nothing hidden should keep the canvas pointing at it. */
    function dropSelection(id) {
        if (fileView.holds(id)) {
            fileView.hide();
        }
        selection.setPinned(id, false);
        if (selection.clicked === id) {
            selection.click(null);
        }
        for (const child of state.index.children.get(id) || []) {
            dropSelection(child.id);
        }
    }

    const exportSettings = () => ({ everywhere: state.exportsOnly, overrides: state.exportOverrides });

    /*
     * Shows only what a module or file exports, or everything in it again. A
     * setting the container would take from above it anyway is not kept, so
     * what the reader set is only ever where it differs from its surroundings.
     */
    function toggleExportsOnly(node) {
        const only = !exportsOnlyAt(state.index, node.id, exportSettings());
        state.exportOverrides.delete(node.id);
        if (exportsOnlyAt(state.index, node.id, exportSettings()) !== only) {
            state.exportOverrides.set(node.id, only);
        }
        render();
    }

    /* One node's diff reads the same way wherever it is shown. */
    function toggleDiffView(node) {
        toggleMembership(state.sideBySide, node.id);
        render();
    }

    function toggleNode(node) {
        // A node either holds source - a function, a constant, a type - or holds
        // other nodes. Clicking opens whichever it is.
        const leaf = isLeaf(node);
        // A container is worth selecting too: what everything inside it calls is
        // a question about the box as a whole.
        selection.click(node.id);
        const before = screenPositionOf(node.id);
        toggleMembership(leaf ? state.openSources : state.expanded, node.id);
        // Every toggle re-runs the layout, which moves everything. Panning the
        // canvas so the node just clicked stays under the pointer keeps the user
        // where they were looking.
        render({ keepInPlace: before && { id: node.id, ...before } });
        selectionChanged();
    }

    function screenPositionOf(id) {
        const element = renderer.elementOf(id);
        if (!element) {
            return null;
        }
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
    }

    function restorePosition({ id, left, top }) {
        const current = screenPositionOf(id);
        if (current) {
            viewportControls.panBy(left - current.left, top - current.top);
        }
    }

    /*
     * Collapsing everything means everything: an open source is a function node
     * left expanded, and it would still be open when its container is reopened.
     * Expanding does not open every source in turn - that is a thousand files of
     * code at once, and not what the reader asked to see.
     */
    function setAllContainers(expanded) {
        state.expanded = expanded
            ? new Set([...state.index.nodes.values()].filter(node => node.kind !== 'function').map(node => node.id))
            : new Set();
        if (!expanded) {
            state.openSources = new Set();
        }
        render({ fit: true });
    }

    return {
        render,
        toggleNode,
        toggleHidden,
        toggleExportsOnly,
        toggleDiffView,
        expandTowardsChanges,
        focusChanges,
        setAllContainers,
        loadGraph,
    };
}
