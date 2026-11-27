const byId = items => new Map(items.map(item => [item.id, item]));

/*
 * Compares two call graphs and reports what one revision did to the other.
 *
 * Nodes are 'added'/'removed' when they appear or disappear, and 'changed' when
 * a function's source (including its documentation) differs. File, module and
 * class nodes have no source of their own; the UI colours them from the state
 * of their children.
 */
export function diffGraphs(before, after) {
    const nodes = {};
    const beforeNodes = byId(before.nodes);
    const afterNodes = byId(after.nodes);

    for (const [id, node] of afterNodes) {
        const previous = beforeNodes.get(id);
        if (!previous) {
            nodes[id] = 'added';
        } else if (node.hash && previous.hash && node.hash !== previous.hash) {
            nodes[id] = 'changed';
        }
    }
    for (const id of beforeNodes.keys()) {
        if (!afterNodes.has(id)) {
            nodes[id] = 'removed';
        }
    }

    const edges = {};
    const beforeEdges = byId(before.edges);
    const afterEdges = byId(after.edges);
    for (const id of afterEdges.keys()) {
        if (!beforeEdges.has(id)) {
            edges[id] = 'added';
        }
    }
    for (const id of beforeEdges.keys()) {
        if (!afterEdges.has(id)) {
            edges[id] = 'removed';
        }
    }

    return { nodes, edges };
}

/* True when a diff contains no node or edge changes at all. */
export const isEmptyDiff = diff => Object.keys(diff.nodes).length === 0 && Object.keys(diff.edges).length === 0;
