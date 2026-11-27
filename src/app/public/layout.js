/*
 * Places the drawn nodes.
 *
 * Two shapes, chosen by what a container holds. A file or a class holds source
 * that is read in order, so its contents are a single column, top to bottom, as
 * they are written. A module holds things of wildly different sizes - an open
 * file thousands of pixels tall beside a closed one thirty pixels tall - so its
 * contents are packed into columns instead, tallest first, filling each column
 * to roughly the same height.
 *
 * Laying modules out by the calls between them, as this used to, spends more of
 * the canvas on the gaps a layered algorithm needs than on the code: a node has
 * to clear every layer between it and what it calls, and one open file drags a
 * whole band of empty space across its module. The call flow that bought is not
 * legible at that scale anyway.
 */
const STACK_GAP = 12;
const PACK_GAP = 24;
const MARGIN = 12;
const TARGET_ASPECT = 1.6;

export const PADDING = { top: 34, left: 16, bottom: 16, right: 16 };
// Files leave room down their right-hand side for the lanes their internal
// calls are drawn in.
export const STACK_PADDING = { ...PADDING, right: 48 };

const STACKED_KINDS = new Set(['file', 'group']);

/*
 * Placement remembers how it arranged each container - which of its contents
 * share a column, and in what order - and only works that out again when what
 * the container holds actually changes.
 *
 * Opening a function changes its size, not the set of things around it, and
 * re-packing on a size change threw every module into a new place each time:
 * the map the reader had built of where things are was destroyed by the act of
 * reading. Keeping the arrangement means the opened node grows, whatever shares
 * its column moves down, and nothing else moves at all.
 */
export function createLayout() {
    const arrangements = new Map();

    const arrange = (id, children, sizes) => {
        const key = children.join('\u0000');
        const remembered = arrangements.get(id);
        if (remembered && remembered.key === key) {
            return remembered.columns;
        }

        const columns = chooseColumns(children, sizes);
        arrangements.set(id, { key, columns });
        return columns;
    };

    return {
        /* Forgets every arrangement, for when the graph itself changes. */
        reset() {
            arrangements.clear();
        },

        run(plan, sizeOf) {
            const tree = treeOf(plan);
            const sizes = new Map();
            const offsets = new Map();

            for (const id of tree.roots) {
                measure(id, tree, sizes, offsets, sizeOf, arrange);
            }

            const positions = new Map();
            const placed = placeColumns(arrange(ROOT, tree.roots, sizes), sizes);
            for (const [id, point] of placed.positions) {
                place(id, point.x + MARGIN, point.y + MARGIN, tree, sizes, offsets, positions);
            }

            return {
                positions,
                stacked: tree.stacked,
                width: placed.width + MARGIN * 2,
                height: placed.height + MARGIN * 2,
            };
        },
    };
}

const ROOT = '';

function treeOf(plan) {
    const items = new Map(plan.drawn.map(item => [item.node.id, item]));
    const children = new Map();
    const roots = [];
    const stacked = new Set();

    for (const item of plan.drawn) {
        const parent = item.node.parent && items.has(item.node.parent) ? item.node.parent : null;
        if (parent) {
            if (!children.has(parent)) {
                children.set(parent, []);
            }
            children.get(parent).push(item.node.id);
        } else {
            roots.push(item.node.id);
        }
        if (item.container && item.expanded && STACKED_KINDS.has(item.node.kind)) {
            stacked.add(item.node.id);
        }
    }

    return { items, children, roots, stacked };
}

/* Sizes a node from the bottom up, recording where its contents sit inside it. */
function measure(id, tree, sizes, offsets, sizeOf, arrange) {
    const item = tree.items.get(id);
    const children = tree.children.get(id) || [];
    const own = sizeOf(id) || { width: 160, height: 32 };

    if (!item.container || !item.expanded || !children.length) {
        sizes.set(id, own);
        return own;
    }

    for (const child of children) {
        measure(child, tree, sizes, offsets, sizeOf, arrange);
    }

    const isStacked = tree.stacked.has(id);
    const padding = isStacked ? STACK_PADDING : PADDING;
    const placed = isStacked ? stackColumn(children, sizes) : placeColumns(arrange(id, children, sizes), sizes);

    for (const [child, point] of placed.positions) {
        offsets.set(child, { x: point.x + padding.left, y: point.y + padding.top });
    }

    // Never narrower than its own header, which is what `own` measures for a
    // container: it is built without its contents.
    const size = {
        width: Math.max(placed.width + padding.left + padding.right, own.width),
        height: placed.height + padding.top + padding.bottom,
    };
    sizes.set(id, size);
    return size;
}

function place(id, x, y, tree, sizes, offsets, positions) {
    const size = sizes.get(id);
    positions.set(id, { x, y, width: size.width, height: size.height });

    for (const child of tree.children.get(id) || []) {
        const offset = offsets.get(child);
        if (offset) {
            place(child, x + offset.x, y + offset.y, tree, sizes, offsets, positions);
        }
    }
}

/* One below the other, in the order they are written. */
function stackColumn(ids, sizes) {
    const positions = new Map();
    let y = 0;
    let width = 0;

    for (const id of ids) {
        const size = sizes.get(id);
        positions.set(id, { x: 0, y });
        y += size.height + STACK_GAP;
        width = Math.max(width, size.width);
    }

    return { positions, width, height: Math.max(0, y - STACK_GAP) };
}

/*
 * Columns of roughly equal height, tallest first: the arrangement that leaves
 * the least empty space when the things being placed are nothing like the same
 * size. Equal-height nodes keep the order they came in, so a module's closed
 * files stay in the order its contents are listed.
 *
 * How tall to fill each column decides everything, and there is no formula for
 * it: with one enormous node and a dozen small ones the answer is the height of
 * the enormous one, with a dozen equal nodes it is several of them. Every
 * height that finishes a column is tried and the tidiest result kept - compact,
 * and no further from a comfortable shape than it has to be.
 */
function chooseColumns(ids, sizes) {
    const boxes = ids.map(id => ({ id, ...sizes.get(id) }));
    if (!boxes.length) {
        return [];
    }

    const sorted = [...boxes].sort((a, b) => b.height - a.height);
    const tallest = Math.max(...sorted.map(box => box.height));

    let best = null;
    for (const target of columnHeights(sorted, tallest)) {
        const columns = fillColumns(sorted, target);
        const placed = placeColumns(columns, sizes);
        const score =
            placed.width * placed.height * (1 + Math.abs(Math.log(placed.width / placed.height / TARGET_ASPECT)));
        if (!best || score < best.score) {
            best = { columns, score };
        }
    }
    return best.columns;
}

/* Every height at which a column could be closed. */
function columnHeights(sorted, tallest) {
    const heights = new Set([tallest]);
    let running = 0;
    for (const box of sorted) {
        running += (running ? PACK_GAP : 0) + box.height;
        heights.add(Math.max(running, tallest));
    }
    return heights;
}

/* Splits the boxes into columns no taller than `target`, in the order given. */
function fillColumns(sorted, target) {
    const columns = [];
    let column = null;
    let height = 0;

    for (const box of sorted) {
        if (!column || height + PACK_GAP + box.height > target) {
            column = [];
            columns.push(column);
            height = 0;
        }
        height += (column.length ? PACK_GAP : 0) + box.height;
        column.push(box.id);
    }
    return columns;
}

/* Geometry for an arrangement, at whatever size its members are now. */
function placeColumns(columns, sizes) {
    const positions = new Map();
    let x = 0;
    let height = 0;

    for (const column of columns) {
        let y = 0;
        for (const id of column) {
            positions.set(id, { x, y });
            y += sizes.get(id).height + PACK_GAP;
        }
        height = Math.max(height, y - PACK_GAP);
        x += Math.max(...column.map(id => sizes.get(id).width)) + PACK_GAP;
    }

    return { positions, width: Math.max(0, x - PACK_GAP), height: Math.max(0, height) };
}
