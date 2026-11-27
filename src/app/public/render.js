import { element, glyph } from './dom.js';
import { PADDING, STACK_PADDING } from './layout.js';
import { nodeDiffStat } from './nodechrome.js';
import { displayName, exportState, hasSource, isLeaf } from './model.js';
import { buildSourceBody, sourceState } from './sourceview.js';

const KIND_LABEL = { module: 'module', file: 'file', group: 'class', function: 'fn' };
const kindLabel = node => {
    // An external is named for what it is on the other side of the boundary -
    // a service, a library - since 'external' is what every one of them is.
    if (node.kind === 'external') {
        return node.externalKind || 'external';
    }
    if (node.kind === 'data') {
        return node.dataKind || 'const';
    }
    if (node.role) {
        return node.role;
    }
    if (node.kind === 'group') {
        return node.groupKind || 'class';
    }
    return KIND_LABEL[node.kind] || node.kind;
};
const ARROW = 7;
const DOT = 3.5;
const CLEARANCE = 12;
const DETOUR_PASSES = 6;
const DRAG_THRESHOLD = 4;
const SEPARATION = 12;
const SEPARATION_PASSES = 4;

/*
 * Draws a render plan: one absolutely positioned DOM element per drawn node
 * (so a function node can hold real, syntax-highlighted source) and one SVG
 * path per edge. Nodes are laid out flat and stacked by depth, which lets a
 * container act as the backdrop of everything inside it.
 *
 * `ui.offsets` is where nodes dragged by hand are recorded; the renderer writes
 * into it and adds the offset of a node and of all its ancestors to whatever
 * the layout decided, so dragging a container carries its contents along.
 */
export function createRenderer({ nodeLayer, measureLayer, edgeLayer, edgeHighlightLayer, interactions }) {
    let nodes = new Map();
    const edges = new Map();
    let context = null;
    let highlighted = new Set();
    const fitted = new Map();

    /* ---------- geometry ---------- */

    const offsetOf = id => context.ui.offsets.get(id) || { dx: 0, dy: 0 };

    function cumulativeOffset(id) {
        let dx = 0;
        let dy = 0;
        let current = id;
        while (current) {
            const offset = offsetOf(current);
            dx += offset.dx;
            dy += offset.dy;
            current = context.parents.get(current);
        }
        return { dx, dy };
    }

    /*
     * Where a node is now. A leaf sits where the layout put it, plus whatever it
     * and its ancestors have been dragged by. An open container is wherever its
     * contents are: it wraps them, which is what makes it shrink back around
     * them when one of them is moved.
     */
    function boxOf(id) {
        if (fitted.has(id)) {
            return fitted.get(id);
        }
        const box = context.layout.positions.get(id);
        if (!box) {
            return null;
        }

        const offset = cumulativeOffset(id);
        const own = { x: box.x + offset.dx, y: box.y + offset.dy, width: box.width, height: box.height };
        const children = context.children.get(id) || [];
        const result = children.length ? wrap(children, id, own) : own;

        fitted.set(id, result);
        return result;
    }

    function wrap(children, id, own) {
        const boxes = children.map(boxOf).filter(Boolean);
        if (!boxes.length) {
            return own;
        }

        const padding = context.layout.stacked.has(id) ? STACK_PADDING : PADDING;
        const left = Math.min(...boxes.map(box => box.x)) - padding.left;
        const top = Math.min(...boxes.map(box => box.y)) - padding.top;
        const right = Math.max(...boxes.map(box => box.x + box.width)) + padding.right;
        const bottom = Math.max(...boxes.map(box => box.y + box.height)) + padding.bottom;

        // Still wide enough for its own header, and no wider than it has to be.
        // The floor is what the header measures on its own, not the width the
        // layout handed out: that width already covered the contents where the
        // layout put them, so it would stop a container closing up around
        // contents dragged together, the way its height does.
        return {
            x: left,
            y: top,
            width: Math.max(right - left, headerWidth(id, own)),
            height: bottom - top,
        };
    }

    /* What a container measures at with nothing in it: its header alone. */
    const headerWidth = (id, own) => context.sizes.get(id)?.width ?? own.width;

    const invalidateBoxes = () => fitted.clear();

    /* ---------- dragging ---------- */

    function restoreOffsets(offsets) {
        context.ui.offsets.clear();
        for (const [id, offset] of offsets) {
            context.ui.offsets.set(id, offset);
        }
    }

    function moveNode(id, offset) {
        context.ui.offsets.set(id, offset);
        invalidateBoxes();
        separate(id);
        invalidateBoxes();

        // Containers wrap their contents, so a move resizes whatever holds it,
        // and pushing a neighbour aside moves everything that neighbour holds.
        for (const item of context.plan.drawn) {
            positionElement(item.node.id);
        }
        refreshEdges(null);
    }

    const overlapping = (a, b) =>
        a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    /* Shifts `id` out of `other`'s way by the shorter of the two directions. */
    function push(id, other, anchor) {
        const box = boxOf(id);
        const dx =
            box.x + box.width / 2 < anchor.x + anchor.width / 2
                ? anchor.x - (box.x + box.width) - SEPARATION
                : anchor.x + anchor.width - box.x + SEPARATION;
        const dy =
            box.y + box.height / 2 < anchor.y + anchor.height / 2
                ? anchor.y - (box.y + box.height) - SEPARATION
                : anchor.y + anchor.height - box.y + SEPARATION;

        const offset = context.ui.offsets.get(id) || { dx: 0, dy: 0 };
        const shift =
            Math.abs(dx) < Math.abs(dy) ? { dx: offset.dx + dx, dy: offset.dy } : { dx: offset.dx, dy: offset.dy + dy };
        context.ui.offsets.set(id, shift);
        invalidateBoxes();
        void other;
    }

    /*
     * A node dragged onto its neighbours pushes them aside rather than landing
     * on top of them, and whatever they are pushed into moves in turn. The node
     * being dragged stays where it was put; everything else gives way. Each
     * level up gets the same treatment, since a container that grew may now
     * cover its own neighbours.
     */
    function separate(movedId) {
        let current = movedId;

        while (current) {
            const parentId = context.parents.get(current);
            const siblings = (context.children.get(parentId) || []).filter(id => id !== current);
            const fixed = new Set([current]);

            for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
                let settled = true;
                for (const anchorId of [...fixed]) {
                    const anchor = boxOf(anchorId);
                    for (const id of siblings) {
                        if (fixed.has(id) || !overlapping(boxOf(id), anchor)) {
                            continue;
                        }
                        push(id, anchorId, anchor);
                        fixed.add(id);
                        settled = false;
                    }
                }
                if (settled) {
                    break;
                }
            }
            current = parentId;
        }
    }

    /*
     * A press on a header drags the node once the pointer has actually
     * travelled; a press that goes nowhere stays an ordinary click and opens or
     * closes the node.
     */
    function bindHeader(header, node, box) {
        let dragged = false;

        header.addEventListener('mousedown', event => {
            if (event.button !== 0) {
                return;
            }
            event.stopPropagation();
            event.preventDefault();
            const start = { x: event.clientX, y: event.clientY };
            const scale = interactions.getScale();
            const initial = context ? { ...offsetOf(node.id) } : { dx: 0, dy: 0 };
            // Where everything sat before this drag. Each move is worked out
            // from here rather than from the frame before it, so dragging
            // across a neighbour nudges it aside once instead of shovelling it
            // along, and backing off puts it back.
            const before = context ? new Map(context.ui.offsets) : new Map();
            dragged = false;

            const onMove = move => {
                const dx = move.clientX - start.x;
                const dy = move.clientY - start.y;
                if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
                    return;
                }
                dragged = true;
                box.classList.add('dragging');
                restoreOffsets(before);
                moveNode(node.id, { dx: initial.dx + dx / scale, dy: initial.dy + dy / scale });
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                box.classList.remove('dragging');
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        header.addEventListener('click', event => {
            event.stopPropagation();
            if (dragged) {
                dragged = false;
                return;
            }
            // A hidden node opens nothing; the way back is its own button.
            if (!box.classList.contains('hidden-node')) {
                interactions.onToggle(node);
            }
        });
    }

    /* ---------- nodes ---------- */

    function buildNode(item, ui) {
        const { node, container, expanded } = item;
        const { hidden, showCode, status, source, base, diffed } = sourceState(node, ui);
        const box = element('div', ['node', `kind-${node.kind}`, container ? 'container' : 'leaf'].join(' '));
        if (node.kind === 'external') {
            box.classList.add(`external-${node.externalKind}`);
        }
        if (expanded) {
            box.classList.add('expanded');
        }
        if (hidden) {
            box.classList.add('hidden-node');
        }
        if (ui.isPinned(node.id)) {
            box.classList.add('pinned');
        }
        if (status) {
            box.classList.add(`status-${status}`);
        }
        box.dataset.id = node.id;

        const header = buildHeader(node, ui, { container, expanded, showCode });
        bindHeader(header, node, box);
        box.append(header);
        // An external is a leaf with nothing to read: it stands for code that is
        // not in the repository, so there is no body to open under its header.
        if (hasSource(node) && showCode) {
            box.append(
                buildSourceBody(node, {
                    source,
                    base,
                    status,
                    diffed,
                    split: ui.sideBySide.has(node.id),
                    blame: diffed ? ui.blameSides(node.file, source.sha) : null,
                }),
            );
        }
        return box;
    }

    function buildHeader(node, ui, { container, expanded, showCode }) {
        const header = element('div', 'node-header');
        const open = container ? expanded : showCode;

        // An external opens onto nothing, so it gets the mark that says data
        // crosses here in place of a chevron promising something to unfold.
        header.append(
            node.kind === 'external' ? element('span', 'node-glyph', '⇄') : element('span', 'chev', open ? '▾' : '▸'),
            element('span', 'node-kind', kindLabel(node)),
            element('span', 'node-name', displayName(node)),
        );
        const exported = exportState(node, ui.selected, ui.view.status.get(node.id));
        if (exported) {
            header.append(exportTag(exported));
        }
        if (ui.exportOverrides.get(node.id)) {
            header.append(exportsOnlyMark());
        }
        header.append(element('span', 'node-meta', metaText(node)));

        const stat = ui.diffStats?.get(node.id);
        if (stat) {
            header.append(nodeDiffStat(stat));
        }
        return header;
    }

    /* The export tag, coloured by what the selection did to the export. */
    const exportTag = exported => {
        const tag = element('span', `node-export export-${exported}`, 'export');
        if (exported === 'added') {
            tag.title = 'Added to the interface by this branch';
        }
        if (exported === 'removed') {
            tag.title = 'Taken out of the interface by this branch';
        }
        return tag;
    };

    /*
     * Says a module or file is showing only what it exports, since what the
     * filter took out of it would otherwise just look absent.
     */
    const exportsOnlyMark = () => {
        const mark = element('span', 'node-exports-only');
        mark.title = 'Showing only what this exports';
        mark.append(glyph('export'), element('span', null, 'exports only'));
        return mark;
    };

    const metaText = node => {
        // Where the boundary leads: the host it is reached over, or the package
        // it is imported from.
        if (node.kind === 'external') {
            return node.host ? `via ${node.package || 'fetch'}` : node.package || '';
        }
        if (isLeaf(node)) {
            return `${node.file}:${node.line}`;
        }
        if (node.kind === 'group') {
            return node.extends || '';
        }
        if (node.kind === 'module') {
            return node.path;
        }
        return '';
    };

    function positionElement(id) {
        const box = boxOf(id);
        const target = nodes.get(id);
        if (!box || !target) {
            return;
        }
        target.style.left = `${box.x}px`;
        target.style.top = `${box.y}px`;
        if (target.classList.contains('container') && target.classList.contains('expanded')) {
            target.style.width = `${box.width}px`;
            target.style.height = `${box.height}px`;
        }
    }

    /* ---------- edges ---------- */

    /* The container both ends of a call are stacked in, if there is one. */
    function sharedStack(edge) {
        const container = context.stackedParents.get(edge.source);
        return container && container === context.stackedParents.get(edge.target) ? container : null;
    }

    function pointsFor(edge, avoiding = false) {
        if (edge.recursive) {
            return selfLoopPoints(boxOf(edge.source));
        }

        const stack = sharedStack(edge);
        const points = stack
            ? bracketPoints(boxOf(edge.source), boxOf(edge.target), boxOf(stack), context.lanes.get(edge.id))
            : elbowPoints(boxOf(edge.source), boxOf(edge.target));

        return points && avoiding ? routeAround(points, openSourceBoxes(edge)) : points;
    }

    /*
     * The boxes an edge must keep off: the open sources, minus its own ends,
     * which it has to reach. Only a followed edge is drawn over the nodes, so
     * only a followed edge has to step around the code it would otherwise lie
     * across.
     */
    function openSourceBoxes(edge) {
        const boxes = [];
        for (const id of context.ui.openSources) {
            if (id === edge.source || id === edge.target) {
                continue;
            }
            const box = boxOf(id);
            if (box) {
                boxes.push(box);
            }
        }
        return boxes;
    }

    /* Draws one edge where it now runs. */
    function place(record) {
        const points = pointsFor(record.edge, record.avoiding);
        if (!points || points.length < 2) {
            return;
        }
        record.path.setAttribute('d', pathData(points));
        record.head.setAttribute('points', arrowPoints(points));
        placeDot(record.dot, points);
    }

    function drawEdges() {
        edges.clear();
        const parts = [];
        for (const layer of [edgeLayer, edgeHighlightLayer]) {
            layer.setAttribute('width', String(context.layout.width + 200));
            layer.setAttribute('height', String(context.layout.height + 200));
        }

        for (const edge of context.plan.edges) {
            const points = pointsFor(edge);
            if (!points || points.length < 2) {
                continue;
            }
            const path = edgePath(edge, points);
            const head = arrowHead(edge, points);
            const dot = edgeDot(edge, points);
            edges.set(edge.id, { edge, path, head, dot, avoiding: false });
            parts.push(path, head, dot);
        }
        edgeLayer.replaceChildren(...parts);
        edgeHighlightLayer.replaceChildren();
        applyHighlight(highlighted);
    }

    function refreshEdges(movedIds) {
        for (const record of edges.values()) {
            const { edge } = record;
            if (movedIds && !movedIds.has(edge.source) && !movedIds.has(edge.target)) {
                continue;
            }
            place(record);
        }
    }

    /*
     * A highlighted edge moves to the layer that is drawn after the nodes, so
     * the call being followed stays visible where it passes behind one - and it
     * is rerouted around any open source on the way, since drawing it over the
     * code would hide what the reader followed it to read.
     */
    function applyHighlight(ids) {
        highlighted = ids;
        for (const record of edges.values()) {
            const { edge, path, head, dot } = record;
            const incident = ids.has(edge.source) || ids.has(edge.target);
            if (incident !== record.avoiding) {
                record.avoiding = incident;
                place(record);
            }

            const layer = incident ? edgeHighlightLayer : edgeLayer;
            for (const part of [path, head, dot]) {
                part.classList.toggle('highlight', incident);
                part.classList.toggle('dimmed', ids.size > 0 && !incident);
                if (part.parentNode !== layer) {
                    layer.append(part);
                }
            }
        }
    }

    /* ---------- passes ---------- */

    return {
        /*
         * Builds the next canvas off screen and measures it. The canvas on
         * screen is left alone: laying out takes long enough that clearing it
         * here would blank the view until the layout came back.
         */
        prepare(plan, ui) {
            const built = new Map();
            const batch = document.createDocumentFragment();

            for (const item of plan.drawn) {
                const box = buildNode(item, ui);
                box.style.left = '0px';
                box.style.top = '0px';
                built.set(item.node.id, box);
                batch.append(box);
            }
            measureLayer.replaceChildren(batch);

            const sizes = new Map();
            for (const [id, box] of built) {
                sizes.set(id, { width: box.offsetWidth + 2, height: box.offsetHeight + 2 });
            }
            return { built, sizes };
        },

        /* Positions the prepared canvas and swaps it in, in one go. */
        commit(prepared, plan, layout, ui) {
            const parents = new Map();
            const children = new Map();
            for (const item of plan.drawn) {
                const parentId = item.node.parent && layout.positions.has(item.node.parent) ? item.node.parent : null;
                parents.set(item.node.id, parentId);
                if (parentId) {
                    if (!children.has(parentId)) {
                        children.set(parentId, []);
                    }
                    children.get(parentId).push(item.node.id);
                }
            }
            const stackedParents = new Map();
            for (const [id, parentId] of parents) {
                if (parentId && layout.stacked.has(parentId)) {
                    stackedParents.set(id, parentId);
                }
            }

            // Calls inside one stacked container run down a lane on its right;
            // giving each its own lane keeps parallel calls apart.
            const lanes = new Map();
            const laneCount = new Map();
            for (const edge of plan.edges) {
                const container = stackedParents.get(edge.source);
                if (!container || container !== stackedParents.get(edge.target)) {
                    continue;
                }
                const next = laneCount.get(container) || 0;
                lanes.set(edge.id, next);
                laneCount.set(container, next + 1);
            }

            nodes = prepared.built;
            fitted.clear();
            context = { plan, layout, ui, parents, children, stackedParents, lanes, sizes: prepared.sizes };

            for (const item of plan.drawn) {
                const box = nodes.get(item.node.id);
                if (box) {
                    box.style.zIndex = String(item.depth + 1);
                }
                positionElement(item.node.id);
            }

            // One swap, one paint: the old canvas is replaced by a fully
            // positioned new one, with the edges redrawn in the same task.
            nodeLayer.replaceChildren(...nodes.values());
            drawEdges();
        },

        applyHighlight,

        elementOf: id => nodes.get(id),
    };
}

/* ---------- edge geometry ---------- */

const pathData = points => points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');

const SVG = 'http://www.w3.org/2000/svg';

function edgePath(edge, points) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', pathData(points));
    path.setAttribute('class', callClasses('edge', edge));
    return path;
}

/* What a call is drawn as: its status, and whether it only reaches a constant. */
const callClasses = (part, edge) =>
    [part, edge.status ? `status-${edge.status}` : '', edge.access ? 'edge-access' : ''].filter(Boolean).join(' ');

function arrowPoints(points) {
    const end = points[points.length - 1];
    const previous = points[points.length - 2];
    const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
    const wing = direction => ({
        x: end.x - ARROW * Math.cos(angle + direction * 0.5),
        y: end.y - ARROW * Math.sin(angle + direction * 0.5),
    });
    const left = wing(1);
    const right = wing(-1);
    return `${end.x},${end.y} ${left.x},${left.y} ${right.x},${right.y}`;
}

function arrowHead(edge, points) {
    const head = document.createElementNS(SVG, 'polygon');
    head.setAttribute('points', arrowPoints(points));
    head.setAttribute('class', callClasses('edge-head', edge));
    return head;
}

/*
 * The dot marks where a call leaves its caller, so an edge that ends at a node
 * can be told from one that only passes beneath it. Only highlighted edges show
 * theirs; the rest would be noise.
 */
function edgeDot(edge, points) {
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('r', String(DOT));
    dot.setAttribute('class', callClasses('edge-dot', edge));
    placeDot(dot, points);
    return dot;
}

function placeDot(dot, points) {
    dot.setAttribute('cx', String(points[0].x));
    dot.setAttribute('cy', String(points[0].y));
}

/*
 * Steps an orthogonal route around the boxes showing source.
 *
 * One crossing is moved per pass - out past the near side of the box it crosses
 * and back - and a detour that lands on another box is moved by the next pass.
 * A route that cannot be freed within a few passes is drawn as it is: a line
 * over code is better than a line that never arrives.
 */
function routeAround(points, boxes) {
    let route = points;
    for (let pass = 0; boxes.length && pass < DETOUR_PASSES; pass += 1) {
        const stepped = stepAround(route, boxes);
        if (stepped === route) {
            break;
        }
        route = stepped;
    }
    return route;
}

function stepAround(points, boxes) {
    for (let index = 0; index < points.length - 1; index += 1) {
        const from = points[index];
        const to = points[index + 1];
        const box = boxes.find(candidate => crosses(from, to, candidate));
        if (!box) {
            continue;
        }
        return [...points.slice(0, index + 1), ...detour(from, to, box), ...points.slice(index + 1)];
    }
    return points;
}

/* Whether a straight run of the route passes through a box. */
function crosses(from, to, box) {
    const right = box.x + box.width;
    const bottom = box.y + box.height;

    if (from.y === to.y) {
        return from.y > box.y && from.y < bottom && Math.max(from.x, to.x) > box.x && Math.min(from.x, to.x) < right;
    }
    if (from.x === to.x) {
        return from.x > box.x && from.x < right && Math.max(from.y, to.y) > box.y && Math.min(from.y, to.y) < bottom;
    }
    return false;
}

/* The way around a box: out to its nearer side, along it, and back. */
function detour(from, to, box) {
    const horizontal = from.y === to.y;
    const along = horizontal ? 'x' : 'y';
    const across = horizontal ? 'y' : 'x';
    const near = horizontal ? box.y : box.x;
    const far = horizontal ? box.y + box.height : box.x + box.width;
    const start = horizontal ? box.x : box.y;
    const end = horizontal ? box.x + box.width : box.y + box.height;

    const lane = from[across] - near <= far - from[across] ? near - CLEARANCE : far + CLEARANCE;
    const forwards = to[along] > from[along];
    const enter = between(forwards ? start - CLEARANCE : end + CLEARANCE, from[along], to[along]);
    const leave = between(forwards ? end + CLEARANCE : start - CLEARANCE, from[along], to[along]);

    return [
        { [along]: enter, [across]: from[across] },
        { [along]: enter, [across]: lane },
        { [along]: leave, [across]: lane },
        { [along]: leave, [across]: from[across] },
    ];
}

const between = (value, a, b) => Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b));

/* A recursive call is drawn as a small loop off the right edge of its node. */
function selfLoopPoints(box) {
    if (!box) {
        return null;
    }
    const x = box.x + box.width;
    const top = box.y + box.height * 0.3;
    const bottom = box.y + box.height * 0.7;
    return [
        { x, y: top },
        { x: x + 26, y: top },
        { x: x + 26, y: bottom },
        { x: x + 2, y: bottom },
    ];
}

/*
 * A call between two functions stacked in the same file runs down a lane on the
 * right of that file, from the caller's right edge into the callee's - the
 * shape a call hierarchy is usually drawn with, and the only one that does not
 * cut through the cards stacked between them.
 */
function bracketPoints(from, to, container, lane = 0) {
    if (!from || !to) {
        return null;
    }
    const x = container
        ? container.x + container.width - 12 - (lane % 4) * 9
        : Math.max(from.x + from.width, to.x + to.width) + 18;
    const startY = from.y + from.height / 2;
    const endY = to.y + to.height / 2;

    return [
        { x: from.x + from.width, y: startY },
        { x, y: startY },
        { x, y: endY },
        { x: to.x + to.width, y: endY },
    ];
}

/*
 * Orthogonal connector for edges ELK did not route itself: calls that cross a
 * container boundary, and anything whose ends have been dragged. Forward calls
 * take a mid-way step, backward calls travel in a lane below both boxes.
 */
function elbowPoints(from, to) {
    if (!from || !to) {
        return null;
    }

    const start = { x: from.x + from.width, y: from.y + from.height / 2 };
    const end = { x: to.x, y: to.y + to.height / 2 };

    if (end.x - start.x > 40) {
        const middle = (start.x + end.x) / 2;
        return [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
    }

    const lane = Math.max(from.y + from.height, to.y + to.height) + 26;
    return [
        start,
        { x: start.x + 22, y: start.y },
        { x: start.x + 22, y: lane },
        { x: end.x - 22, y: lane },
        { x: end.x - 22, y: end.y },
        end,
    ];
}
