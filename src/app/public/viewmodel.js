import { isContainer } from './model.js';

/*
 * What the canvas draws for a given expand/collapse state: the nodes, and the
 * finest-grained visible node every node's edges are attributed to.
 *
 * A node inside a collapsed container is not drawn; its calls are attributed to
 * the outermost collapsed container above it, which is exactly the rule in the
 * README: a call from a collapsed file A to a function in an expanded file B is
 * drawn from file A's node to that function.
 *
 * Which roots to walk is the caller's business.
 */
export function planNodes(index, view, expanded, roots) {
    const drawn = [];
    const anchor = new Map();

    const walk = (node, depth, inheritedAnchor) => {
        if (!view.present.has(node.id)) {
            return;
        }

        const container = isContainer(node);
        // A hidden node is drawn shut, whatever it was before it was hidden.
        const isExpanded = container && expanded.has(node.id) && !view.hidden?.has(node.id);
        const ownAnchor = inheritedAnchor || (isExpanded ? null : node.id);

        if (!inheritedAnchor) {
            drawn.push({ node, depth, expanded: isExpanded, container });
        }
        anchor.set(node.id, ownAnchor || node.id);

        for (const child of index.children.get(node.id) || []) {
            walk(child, depth + 1, ownAnchor);
        }
    };

    for (const root of roots) {
        walk(root, 0, null);
    }

    return { drawn, anchor };
}

/* The nodes and the calls between them: what call mode puts on the canvas. */
export function buildRenderPlan(index, view, expanded) {
    // An external belongs to no file, so it arrives as a root of its own, and
    // call mode has nothing to say about it.
    const { drawn, anchor } = planNodes(
        index,
        view,
        expanded,
        index.roots.filter(root => root.kind !== 'external'),
    );
    return { drawn, anchor, edges: aggregateEdges(index, view, anchor) };
}

function aggregateEdges(index, view, anchor) {
    const aggregated = new Map();

    for (const edge of index.edges) {
        if (!view.edgePresent.has(edge.id)) {
            continue;
        }
        // Edges into an external drop out on their own, since an undrawn node
        // anchors nothing.
        const source = anchor.get(edge.source);
        const target = anchor.get(edge.target);
        if (!source || !target) {
            continue;
        }

        // Both ends collapsed into the same box: the call is internal to it, and
        // only a genuinely recursive function keeps its self-edge.
        const recursive = edge.source === edge.target;
        if (source === target && !(recursive && source === edge.source)) {
            continue;
        }

        const id = `${source}->${target}`;
        const existing = aggregated.get(id) || {
            id,
            source,
            target,
            recursive: source === target,
            count: 0,
            statuses: new Set(),
            kinds: new Set(),
            members: [],
        };
        existing.count += edge.callCount || 1;
        existing.statuses.add(view.edgeStatus.get(edge.id) || null);
        existing.kinds.add(edge.kind || 'call');
        existing.members.push(edge.id);
        aggregated.set(id, existing);
    }

    return [...aggregated.values()].map(edge => ({
        ...edge,
        status: mergeStatuses(edge.statuses),
        // Reaching a constant is not calling it: an edge drawn for reads and
        // writes alone is drawn as one. Two collapsed boxes joined by both
        // count as calls, which is the stronger claim of the two.
        access: edge.kinds.size === 1 && edge.kinds.has('access'),
    }));
}

/*
 * An aggregated edge is only coloured when every call it stands for changed the
 * same way; a mix of added, removed and untouched calls is drawn neutrally.
 */
function mergeStatuses(statuses) {
    if (statuses.size !== 1) {
        return null;
    }
    return [...statuses][0];
}
