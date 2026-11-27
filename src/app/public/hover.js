import {
    ancestors,
    describeContainer,
    describeCounts,
    groupCallsByContainer,
    hasSource,
    incomingCalls,
    isMethod,
    outgoingCalls,
} from './model.js';
import { createCallsWindow } from './calls.js';
import { rowForLine } from './code.js';
import { describeToTooltip } from './tooltip.js';
import { toggleMembership } from './shell.js';

/*
 * What the pointer is on, what has been selected, and where the reader is taken
 * when they follow a call.
 *
 * The calls window is built here rather than passed in: every one of its
 * handlers is one of these functions, and what it lists is the selection this
 * module keeps.
 */
export function createHover({
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
}) {
    const callsWindow = createCallsWindow({
        root: elements.callsWindow,
        title: elements.callsTitle,
        groups: elements.callsGroups,
        dock: elements.callsDock,
        close: elements.callsClose,
        handlers: {
            onJump: (id, from) => navigateTo(id, from).catch(reportError),
            onRemove: id => {
                selection.remove(id);
                showPinned(id, false);
                selectionChanged();
            },
            onToggleGroup: id => {
                toggleMembership(state.openGroups, id);
                refreshCalls();
            },
            onClose: () => deselectAll(),
            onPointerIn: () => clearTimeout(hoverTimer),
            onPointerOut: () => scheduleHoverClear(),
        },
    });

    /*
     * Losing the pointer is delayed so that it can travel from a node to the
     * calls window without the window disappearing on the way.
     */
    let hoverTimer = null;

    function setHovered(id) {
        clearTimeout(hoverTimer);
        selection.hover(id);
        selectionChanged();
    }

    /* The pointer on a panel is the pointer still on what the panel is about. */
    function keepHovered() {
        clearTimeout(hoverTimer);
    }

    function scheduleHoverClear() {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => setHovered(null), 300);
    }

    function selectionChanged() {
        applyHighlight();
        refreshCalls();
        reopenFile();
    }

    /*
     * Only the newest selection is open; a group opened by hand stays open
     * until something else takes the top spot.
     */
    function openGroupsFor(functions) {
        const top = functions[0]?.id ?? null;
        if (top !== state.topGroup) {
            state.topGroup = top;
            state.openGroups = new Set(top ? [top] : []);
        }
        return state.openGroups;
    }

    /* Drops every selection, pins and all. */
    function deselectAll() {
        clearTimeout(hoverTimer);
        for (const id of selection.clear()) {
            showPinned(id, false);
        }
        selectionChanged();
    }

    function showPinned(id, isPinned) {
        // The menu's pin button says whether its node is pinned, so it is
        // redrawn to say so now.
        nodeMenu.refresh(state.lastUi);
        const element = renderer.elementOf(id);
        if (!element) {
            return;
        }
        element.classList.toggle('pinned', isPinned);
    }

    /*
     * What the calls window is listing, most recently selected first: functions
     * and constants, which have ends of their own, and containers, which answer
     * for everything inside them. An external is a boundary, not something with
     * calls of its own.
     */
    function selectedCallers() {
        if (!state.index) {
            return [];
        }
        return selection
            .list()
            .map(id => state.index.nodes.get(id))
            .filter(node => node && node.kind !== 'external');
    }

    function refreshCalls() {
        const listed = selectedCallers();
        if (!listed.length || !state.lastView) {
            callsWindow.hide();
            return;
        }
        const open = openGroupsFor(listed);
        // Grouped by what holds them here rather than in the window: which
        // module or file a call lands in is a fact about the graph, and the
        // window's business is only how much of it is folded away.
        const grouped = calls => ({ total: calls.length, ...groupCallsByContainer(state.index, calls) });
        callsWindow.show(
            listed.map(node => ({
                node,
                calls: grouped(outgoingCalls(state.index, state.lastView, node.id)),
                callers: grouped(incomingCalls(state.index, state.lastView, node.id)),
                open: open.has(node.id),
                status: state.lastView.status.get(node.id) || null,
                method: isMethod(state.index, node),
            })),
        );
    }

    /*
     * Following a call is a navigation: it goes into the browser's history, with
     * an entry for where it was followed from, so Back returns to the calling
     * function.
     */
    function navigateTo(id, from, options) {
        if (from && history.state?.focus !== from) {
            history.pushState({ focus: from }, '');
        }
        history.pushState({ focus: id }, '');
        return jumpTo(id, options);
    }

    window.addEventListener('popstate', event => {
        const id = event.state?.focus;
        if (id && state.index?.nodes.has(id)) {
            jumpTo(id).catch(reportError);
        }
    });

    /*
     * Opens whatever hides a function, opens the function itself, brings it into
     * view and flashes it: arriving at a function is arriving at its source.
     *
     * Following a call extends the trail, so the function it was followed from
     * keeps its calls listed. Picking an item out of a list is not a step along
     * a trail but a new starting point, so `fresh` drops the previous one.
     *
     * `line` is a line of the function's source to arrive at rather than the
     * function as a whole: where a local it declares is defined.
     */
    async function jumpTo(id, { fresh = false, line = null } = {}) {
        for (const ancestor of ancestors(state.index, id)) {
            state.expanded.add(ancestor);
        }
        const target = state.index.nodes.get(id);
        // An external has nothing to open: it is a package, not source.
        if (target && hasSource(target)) {
            state.openSources.add(id);
        }
        if (fresh) {
            selection.click(id);
        } else {
            selection.follow(id);
        }
        await render();

        const element = renderer.elementOf(id);
        if (!element) {
            return;
        }
        const row = line ? rowForLine(element, line) : null;
        if (row) {
            scrollIntoBody(row);
        }
        const arrival = row || element;
        await viewportControls.centerOn(arrival);
        arrival.classList.remove('flash');
        void arrival.offsetWidth;
        arrival.classList.add('flash');
        setHovered(null);
    }

    /*
     * Scrolls a node's source so a row of it is in the middle. The canvas is
     * scaled, and what the body scrolls by is not, so the distance on screen is
     * measured back to the body's own.
     */
    function scrollIntoBody(row) {
        const body = row.closest('.node-body');
        if (!body) {
            return;
        }
        const scale = viewportControls.getScale();
        const offset = (row.getBoundingClientRect().top - body.getBoundingClientRect().top) / scale;
        body.scrollTop += offset - (body.clientHeight - row.offsetHeight) / 2;
    }

    /* Every selected node keeps its calls highlighted, and the rest dimmed. */
    function applyHighlight() {
        renderer.applyHighlight(selection.ids());
    }

    elements.viewport.addEventListener('mouseover', event => {
        const node = event.target.closest('.node');
        if (node) {
            setHovered(node.dataset.id);
        } else if (!nodeMenu.holds(event.target)) {
            // A node's own menu is not the canvas between the nodes: reaching
            // for it leaves the node still under the pointer, calls and all.
            scheduleHoverClear();
        }
    });

    /*
     * Resting on a node's header brings up what can be done to it, and for a
     * container what it holds. This follows movement rather than mouseover: the
     * pointer is often already inside a header when a node lands under it, and
     * entering a header from outside is only one of the ways to arrive.
     */
    elements.viewport.addEventListener('mousemove', event => {
        // A held button is a drag - of the canvas or of a node - and not a read.
        if (event.buttons) {
            return;
        }

        // The pointer on the menu is the pointer still on its node.
        if (nodeMenu.holds(event.target)) {
            nodeMenu.keep();
            return;
        }

        const node = event.target.closest('.node-header') && event.target.closest('.node');
        if (!node || !state.lastView) {
            tooltip.hide();
            nodeMenu.leave();
            return;
        }

        const hovered = state.index.nodes.get(node.dataset.id);
        if (hovered && state.lastUi) {
            nodeMenu.enter(hovered, state.lastUi, { x: event.clientX, y: event.clientY });
        }
        tooltip.schedule(
            () => {
                const described = describeContainer(state.index, state.lastView, node.dataset.id);
                return described ? describeToTooltip(described, describeCounts(described.counts)) : null;
            },
            { x: event.clientX, y: event.clientY },
        );
    });

    for (const event of ['mousedown', 'wheel']) {
        elements.viewport.addEventListener(
            event,
            // A press or a scroll moves the canvas out from under the menu -
            // except a press on the menu, which is the whole point of it being
            // there. This watches on the way down: a press on a header is the
            // start of a drag, and the header keeps that press to itself.
            moved => {
                tooltip.hide();
                if (!nodeMenu.holds(moved.target)) {
                    nodeMenu.hide();
                }
            },
            { capture: true, passive: true },
        );
    }
    elements.viewport.addEventListener('mouseleave', () => {
        tooltip.hide();
        nodeMenu.hide();
    });

    return {
        setHovered,
        keepHovered,
        scheduleHoverClear,
        selectionChanged,
        deselectAll,
        showPinned,
        refreshCalls,
        applyHighlight,
        navigateTo,
        jumpTo,
    };
}
