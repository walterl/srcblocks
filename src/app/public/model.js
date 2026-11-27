/*
 * Graph model: indexing, and turning a branch analysis plus a commit selection
 * into per-node/per-edge diff status and visibility. Pure functions - the
 * canvas re-derives everything from here whenever the selection changes.
 */

import { countChanges, diffLines } from './diff-lines.js';

const KIND_ORDER = { module: 0, file: 1, group: 2, data: 3, function: 4, external: 5 };

/*
 * Nodes that hold source of their own rather than other nodes. An external
 * holds no source either, but it holds nothing else either: it has no children
 * and is never opened, so counting it as a leaf keeps it on the canvas and
 * leaves every caller with something sensible to do with it.
 */
const LEAF_KINDS = new Set(['function', 'data', 'external']);
export const isLeaf = node => LEAF_KINDS.has(node.kind);

export const isContainer = node => !LEAF_KINDS.has(node.kind);

/* Nodes with source of their own to read, diff and search: not an external. */
export const hasSource = node => node.kind === 'function' || node.kind === 'data';

/*
 * Siblings that live in the same file are ordered the way they are written;
 * everything else (files in a module, modules in a module) has no source order
 * to follow and is ordered by kind and name.
 */
const bySourceOrder = (a, b) => {
    if (Number.isFinite(a.line) && Number.isFinite(b.line) && a.line !== b.line) {
        return a.line - b.line;
    }
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
};

export function indexGraph(graph) {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const children = new Map();
    const roots = [];

    for (const node of graph.nodes) {
        if (node.parent && nodes.has(node.parent)) {
            if (!children.has(node.parent)) {
                children.set(node.parent, []);
            }
            children.get(node.parent).push(node);
        } else {
            roots.push(node);
        }
    }

    roots.sort(bySourceOrder);
    for (const list of children.values()) {
        list.sort(bySourceOrder);
    }

    return { nodes, children, roots, edges: graph.edges };
}

/* Ancestor chain of a node, nearest parent first. */
export function ancestors(index, id) {
    const chain = [];
    let current = index.nodes.get(id)?.parent;
    while (current && index.nodes.has(current)) {
        chain.push(current);
        current = index.nodes.get(current).parent;
    }
    return chain;
}

/*
 * How a node's status evolves when the next selected commit touches it. A node
 * added and then removed within the selection ends up 'gone' - it never existed
 * in the state the selection describes, so it is not drawn at all.
 */
const FOLD = {
    none: { added: 'added', changed: 'changed', removed: 'removed' },
    added: { added: 'added', changed: 'added', removed: 'gone' },
    changed: { added: 'changed', changed: 'changed', removed: 'removed' },
    removed: { added: 'changed', changed: 'changed', removed: 'removed' },
    gone: { added: 'added', changed: 'added', removed: 'gone' },
};

const foldStatus = (current, next) => FOLD[current || 'none'][next] || current;

/*
 * Folds the diffs of the selected commits, in commit order, into one status per
 * node and per edge.
 */
export function foldSelection(analysis, selected) {
    const nodes = new Map();
    const edges = new Map();
    if (!analysis) {
        return { nodes, edges };
    }

    for (const commit of analysis.commits) {
        if (!selected.has(commit.sha)) {
            continue;
        }
        const diff = analysis.perCommit[commit.sha];
        if (!diff) {
            continue;
        }
        for (const [id, status] of Object.entries(diff.nodes)) {
            nodes.set(id, foldStatus(nodes.get(id), status));
        }
        for (const [id, status] of Object.entries(diff.edges)) {
            edges.set(id, foldStatus(edges.get(id), status));
        }
    }

    return { nodes, edges };
}

/*
 * Whether an element the selection describes should be drawn, and with which
 * diff colour. 'added' on something the base already had is an artefact of a
 * merge re-introducing it, and is shown as unchanged.
 */
function resolveStatus(element, folded) {
    if (folded === 'gone') {
        return { present: false, status: null };
    }
    if (folded === 'added') {
        return element.inBase === true ? { present: true, status: null } : { present: true, status: 'added' };
    }
    if (folded === 'changed' || folded === 'removed') {
        return { present: true, status: folded };
    }
    return { present: element.inBase !== false, status: null };
}

/*
 * The state of the graph under a commit selection:
 *   present    - ids to draw
 *   status     - id -> 'added' | 'changed' | 'removed' (containers inherit
 *                'changed' from any descendant that changed)
 */
export function deriveViewState(index, analysis, selected, hidden = new Set()) {
    const folded = foldSelection(analysis, selected);
    const present = new Set();
    const status = new Map();
    const covered = hiddenCover(index, hidden);
    // Nodes the selection never had: added and removed again inside it.
    const gone = new Set();

    for (const node of index.nodes.values()) {
        // What a hidden node holds is not on the canvas at all; the node itself
        // stays, so it can be brought back, but says nothing about anything.
        if (covered.inside.has(node.id)) {
            continue;
        }

        const foldedStatus = folded.nodes.get(node.id);
        if (foldedStatus === 'gone') {
            gone.add(node.id);
        }
        const resolved = resolveStatus(node, foldedStatus);
        if (resolved.present) {
            present.add(node.id);
        }
        if (covered.roots.has(node.id)) {
            continue;
        }
        // Commits that changed a function and changed it back leave it as the
        // base revision had it: touched, but not changed by this selection.
        if (resolved.status && !(resolved.status === 'changed' && matchesBase(node, selected))) {
            status.set(node.id, resolved.status);
        }
    }

    const edgePresent = new Set();
    const edgeStatus = new Map();
    for (const edge of index.edges) {
        if (covered.holds(edge.source) || covered.holds(edge.target)) {
            continue;
        }
        // A node the selection never had takes its calls with it. Its last
        // revision still records them, and drawing one would put the node back
        // on the canvas - source and all - as an end the call says exists.
        if (gone.has(edge.source) || gone.has(edge.target)) {
            continue;
        }

        const resolved = edgeState(index, edge, selected, status, folded);
        if (!resolved.present) {
            continue;
        }
        edgePresent.add(edge.id);
        if (resolved.status) {
            edgeStatus.set(edge.id, resolved.status);
        }

        // A call that exists says both of its ends exist, even where the node
        // itself was added by a commit this selection leaves out.
        if (index.nodes.has(edge.source)) {
            present.add(edge.source);
        }
        if (index.nodes.has(edge.target)) {
            present.add(edge.target);
        }
    }

    // Containers last: what the edges brought back has to bring its file and
    // module with it.
    for (const root of index.roots) {
        resolveContainer(index, root, present, status, covered.roots);
    }

    return { present, status, edgePresent, edgeStatus, hidden: covered.roots };
}

/*
 * What hiding a node covers: the node itself, which stays on the canvas, and
 * everything under it, which does not.
 */
function hiddenCover(index, hidden) {
    const roots = new Set();
    const inside = new Set();

    const swallow = node => {
        inside.add(node.id);
        for (const child of index.children.get(node.id) || []) {
            swallow(child);
        }
    };

    for (const id of hidden) {
        if (!index.nodes.has(id)) {
            continue;
        }
        roots.add(id);
        for (const child of index.children.get(id) || []) {
            swallow(child);
        }
    }

    return { roots, inside, holds: id => roots.has(id) || inside.has(id) };
}

/*
 * Whether a call exists under the current selection, and what the branch did to
 * it - decided the way a function's source is: the calls the base revision made
 * against the calls made by the revision the selection shows.
 *
 * Folding each commit's edge changes instead would disagree with the source on
 * screen, since a revision's source carries every earlier commit whether it is
 * selected or not.
 */
/*
 * A recorded call is `{ target, carries }`; a graph analysed before carried
 * types were recorded - or a hand-built one - records the target id alone.
 */
const targetOf = call => (typeof call === 'string' ? call : call.target);
const callsInclude = (calls, target) => Array.isArray(calls) && calls.some(call => targetOf(call) === target);

function edgeState(index, edge, selected, nodeStatus, folded) {
    const source = index.nodes.get(edge.source);
    const base = source && baseSourceOf(source);
    const current = source && sourceOf(source, selected);
    const known = Array.isArray(base?.calls) || Array.isArray(current?.calls);

    if (!known) {
        const resolved = resolveStatus(edge, folded.edges.get(edge.id));
        const status = resolved.status === 'changed' ? null : resolved.status;
        return { present: resolved.present && index.nodes.has(edge.target), status };
    }

    // Everything a removed function called goes with it.
    if (nodeStatus.get(edge.source) === 'removed') {
        return { present: callsInclude(base?.calls, edge.target), status: 'removed' };
    }

    const inBase = callsInclude(base?.calls, edge.target);
    const inNow = callsInclude(current?.calls, edge.target);

    if (inNow && inBase) {
        return { present: true, status: null };
    }
    if (inNow) {
        return { present: true, status: 'added' };
    }
    if (inBase) {
        return { present: true, status: 'removed' };
    }
    return { present: false, status: null };
}

function matchesBase(node, selected) {
    if (!isLeaf(node)) {
        return false;
    }
    const base = baseSourceOf(node);
    const current = sourceOf(node, selected);
    return Boolean(base?.hash && current?.hash && base.hash === current.hash);
}

function resolveContainer(index, node, present, status, hidden) {
    if (isLeaf(node)) {
        return present.has(node.id) || status.has(node.id);
    }
    // A hidden container holds nothing and says nothing, but it is still on the
    // canvas: it stays, and so does whatever holds it.
    if (hidden.has(node.id)) {
        return present.has(node.id);
    }

    const children = index.children.get(node.id) || [];
    let liveChild = false;
    let changedChild = false;
    for (const child of children) {
        if (resolveContainer(index, child, present, status, hidden)) {
            liveChild = true;
        }
        if (status.has(child.id)) {
            changedChild = true;
        }
    }

    const own = status.get(node.id);
    if (own === 'added' || own === 'removed') {
        return present.has(node.id);
    }

    if (!liveChild && !own) {
        present.delete(node.id);
        return false;
    }
    if (changedChild && !own) {
        status.set(node.id, 'changed');
    }
    present.add(node.id);
    return true;
}

/*
 * The source a function node shows under a commit selection: what the newest
 * selected commit made of it, or the base revision's version when no selected
 * commit touched it. Nodes from a single-revision graph carry their source
 * directly.
 */
export function sourceOf(node, selected) {
    if (!node.versions) {
        return {
            code: node.code || '',
            refs: node.refs || [],
            doc: node.doc || null,
            hash: node.hash,
            line: node.line,
        };
    }
    for (let index = node.versions.length - 1; index >= 0; index -= 1) {
        if (selected.has(node.versions[index].sha)) {
            return node.versions[index];
        }
    }
    return node.base || { code: '', doc: null };
}

/*
 * Where a node lives, in the form vim reads after `:edit `.
 *
 * `+12 src/a.js` opens the file with the cursor on line 12; a module or a file
 * is a plain path, which vim opens as a directory listing or a buffer. Spaces
 * are escaped, since vim would otherwise read them as the end of the name.
 */
export function vimLocation(node) {
    const path = node.kind === 'module' ? node.path : node.file;
    if (!path) {
        return null;
    }

    const escaped = path.replace(/ /g, String.raw`\ `);
    const line = node.kind === 'module' || node.kind === 'file' ? null : node.line;
    return line ? `+${line} ${escaped}` : escaped;
}

/*
 * The lines a node takes up in its file: where its source starts, and how many
 * lines of it there are.
 *
 * A node with no source of its own is measured by where it ends instead, which
 * is what a class knows about itself - its methods are its body, and its body
 * is what a reader opening it came for. A file, and anything that records
 * neither, is just its own line.
 */
export function lineRange(node, source) {
    const from = source?.line || node.line || 1;
    const code = source?.code || '';
    if (code) {
        return { from, to: from + code.split('\n').length - 1 };
    }
    return { from, to: Math.max(from, node.endLine || from) };
}

/* What the same function looked like before the branch, if it existed then. */
export const baseSourceOf = node => node.base || null;

/*
 * Whether a node is exported under a commit selection, and what the selection
 * did to that: 'exported' when it is and always was, 'added' when the selection
 * added it to the module's interface - by exporting it, or by adding it
 * exported - 'removed' when the selection stopped exporting it or removed it
 * while exported, and null when it is not exported at all. `status` is what
 * the selection did to the node. Only a node with source has revisions to
 * compare; a class is read as it stands, and is only known to be new or gone.
 */
export function exportState(node, selected, status = null) {
    if (status === 'removed') {
        const was = node.versions ? baseSourceOf(node)?.exported : node.exported;
        return was ? 'removed' : null;
    }
    if (!node.versions) {
        if (!node.exported) {
            return null;
        }
        return node.inBase === false ? 'added' : 'exported';
    }
    const now = Boolean(sourceOf(node, selected).exported);
    const base = baseSourceOf(node);
    if (!base) {
        return now ? 'added' : null;
    }
    if (Boolean(base.exported) === now) {
        return now ? 'exported' : null;
    }
    return now ? 'added' : 'removed';
}

const byLocation = (a, b) =>
    (a.node.file || '').localeCompare(b.node.file || '') || (a.node.line || 0) - (b.node.line || 0);

/*
 * Two references merged: a read and a write of the same constant is both. A
 * reference merged with a call is a call, which is the stronger claim.
 */
function mergeAccess(current, edge) {
    if (edge.kind !== 'access' || current === null) {
        return null;
    }
    const mode = edge.mode || 'read';
    return current === mode ? current : 'both';
}

/* Down the caller's body, in the order the calls are written. */
const bySite = (a, b) => (a.site || 0) - (b.site || 0) || byLocation(a, b);

/*
 * Whether a function belongs to a class or an interface rather than standing on
 * its own. A suite's members are tests, not methods.
 */
export function isMethod(index, node) {
    if (node.kind !== 'function' || node.role) {
        return false;
    }
    const parent = index.nodes.get(node.parent);
    return Boolean(parent && parent.kind === 'group' && parent.groupKind !== 'suite');
}

/*
 * Which nodes' calls a selected node speaks for. A function speaks for itself.
 * A module, a file or a class speaks for everything inside it, so asking a
 * class what it calls answers with every call its methods make - the same list
 * selecting each method in turn would give.
 */
export function callSites(index, id) {
    const node = index.nodes.get(id);
    if (!node) {
        return new Set();
    }
    if (isLeaf(node)) {
        return new Set([id]);
    }

    const within = new Set();
    const walk = current => {
        for (const child of index.children.get(current) || []) {
            if (isLeaf(child)) {
                within.add(child.id);
            } else {
                walk(child.id);
            }
        }
    };
    walk(id);
    return within;
}

/*
 * The calls at one end of a selection, as the graph knows them - not as the
 * canvas happens to be drawing them, so a call into a collapsed file counts
 * too.
 *
 * Every call to the same function is one entry, standing for all of its sites:
 * two methods of a class calling the same helper is one thing the class does,
 * said once and counted.
 *
 * What one function calls is ordered by where in that function the calls are
 * written. Anything else is ordered by where the functions at the other end
 * are: call sites spread across a class or a module are positions in different
 * files, and say nothing about order.
 */
function relatedCalls(index, view, ids, from, to) {
    const merged = new Map();

    for (const edge of index.edges) {
        if (!ids.has(edge[from]) || !view.edgePresent.has(edge.id)) {
            continue;
        }
        if (!isCallOf(index, edge, to)) {
            continue;
        }
        const node = index.nodes.get(edge[to]);
        if (!node) {
            continue;
        }

        const existing = merged.get(node.id);
        if (!existing) {
            merged.set(node.id, {
                id: edge.id,
                node,
                site: edge.line || 0,
                // Reading a constant is not calling it, and the entry says which
                // it is: 'read', 'write' or 'both' for a reference, and nothing
                // at all for a call.
                access: edge.kind === 'access' ? edge.mode || 'read' : null,
                // What the branch did to the call, and what it did to the
                // function at the other end: a new call can land on a function
                // that has not changed, and an untouched call on one that has.
                statuses: new Set([view.edgeStatus.get(edge.id) || null]),
                nodeStatus: view.status.get(node.id) || null,
                method: isMethod(index, node),
                callCount: edge.callCount || 1,
                recursive: edge.source === edge.target,
            });
            continue;
        }
        existing.statuses.add(view.edgeStatus.get(edge.id) || null);
        existing.access = mergeAccess(existing.access, edge);
        existing.callCount += edge.callCount || 1;
        existing.recursive = existing.recursive || edge.source === edge.target;
        existing.site = Math.min(existing.site || 0, edge.line || 0);
    }

    const calls = [...merged.values()].map(({ statuses, ...call }) => ({
        ...call,
        // Only where every site agrees is the entry itself added or removed.
        status: statuses.size === 1 ? [...statuses][0] : null,
    }));
    return calls.sort(from === 'source' && ids.size === 1 ? bySite : byLocation);
}

/*
 * Reaching a constant counts: a function that reads a threshold depends on it
 * as surely as one that calls a helper, and the list is how those ends are
 * navigated. Reaching a package does not - an external holds no source, so
 * there is nothing at the other end to navigate to.
 */
const isCallOf = (index, edge, to) => index.nodes.get(edge[to])?.kind !== 'external';

/*
 * The same calls, arranged by what holds them: a tree of the modules, files and
 * classes the far end of each call lives in, with the calls hanging off the
 * container that declares them and a count on every branch of everything
 * beneath it. A list of five hundred calls is unreadable as a list and plain as
 * a tree of the twelve modules they land in.
 *
 * The tree follows the graph, except that a run of modules holding nothing but
 * each other reads as the one path it is. Calls the graph holds outside any
 * container are returned beside the tree, since there is nothing to file them
 * under.
 */
export function groupCallsByContainer(index, calls) {
    const branches = [];
    const byId = new Map();
    const loose = [];

    for (const call of calls) {
        let siblings = branches;
        let holder = null;

        for (const id of ancestors(index, call.node.id).reverse()) {
            const node = index.nodes.get(id);
            if (!node) {
                continue;
            }

            let branch = byId.get(id);
            if (!branch) {
                branch = { id, node, count: 0, children: [], calls: [] };
                byId.set(id, branch);
                siblings.push(branch);
            }
            branch.count += 1;
            siblings = branch.children;
            holder = branch;
        }

        (holder ? holder.calls : loose).push(call);
    }

    return { branches: branches.map(compactBranch), calls: loose };
}

/*
 * A module that holds nothing but one more module is a step on the way rather
 * than a level to open, and a level to open costs a click: the two read as one
 * row, 'src/app/public'. Only paths join like that - a class inside a file is
 * something else inside it, and keeps its own row.
 */
function compactBranch(branch) {
    const names = [branch.node.name];
    let deepest = branch;

    while (!deepest.calls.length && deepest.children.length === 1 && isPath(deepest.children[0].node)) {
        deepest = deepest.children[0];
        names.push(deepest.node.name);
    }

    return { ...deepest, name: names.join('/'), children: deepest.children.map(compactBranch) };
}

const isPath = node => node.kind === 'module' || node.kind === 'file';

/* What a function, or everything inside a container, calls. */
export const outgoingCalls = (index, view, nodeId) =>
    relatedCalls(index, view, callSites(index, nodeId), 'source', 'target');

/* What calls it, or calls into it. */
export const incomingCalls = (index, view, nodeId) =>
    relatedCalls(index, view, callSites(index, nodeId), 'target', 'source');

const KIND_PLURALS = {
    module: ['module', 'modules'],
    file: ['file', 'files'],
    class: ['class', 'classes'],
    suite: ['suite', 'suites'],
    test: ['test', 'tests'],
    hook: ['hook', 'hooks'],
    interface: ['interface', 'interfaces'],
    type: ['type', 'types'],
    enum: ['enum', 'enums'],
    constant: ['constant', 'constants'],
    function: ['function', 'functions'],
};
const COUNT_ORDER = [
    'module',
    'file',
    'class',
    'interface',
    'type',
    'enum',
    'constant',
    'function',
    'suite',
    'test',
    'hook',
];

/* What a node counts as in a container's tally. */
export const declarationKind = node => {
    if (node.kind === 'data') {
        return node.dataKind || 'constant';
    }
    if (node.kind === 'group') {
        return node.groupKind || 'class';
    }
    if (node.kind === 'function' && node.role) {
        return node.role;
    }
    return node.kind;
};

/*
 * What to call a node on screen. Only a function is written with parentheses; a
 * test, a hook and a suite are named by what they say they are.
 */
export const displayName = node => (node.kind === 'function' && !node.role ? `${node.name}()` : node.name);

/*
 * What a module, file or class holds, for its tooltip: where it lives, what is
 * inside it, and what the branch did to the functions in it. Only what the
 * current selection shows is counted, so the tooltip agrees with the canvas.
 */
export function describeContainer(index, view, nodeId) {
    const node = index.nodes.get(nodeId);
    if (!node || node.kind === 'function') {
        return null;
    }

    const counts = {};
    const changes = { added: 0, changed: 0, removed: 0 };

    const walk = id => {
        for (const child of index.children.get(id) || []) {
            if (!view.present.has(child.id)) {
                continue;
            }
            const kind = declarationKind(child);
            counts[kind] = (counts[kind] || 0) + 1;
            const status = isLeaf(child) ? view.status.get(child.id) : null;
            if (status && status in changes) {
                changes[status] += 1;
            }
            walk(child.id);
        }
    };
    walk(nodeId);

    return {
        kind: node.kind === 'group' ? node.groupKind || 'class' : node.kind,
        path: pathOf(node),
        counts,
        changes,
        status: view.status.get(nodeId) || null,
    };
}

/* Where a node lives, in one string: what search matches paths against. */
export const nodePath = node => {
    if (node.kind === 'module') {
        return node.path;
    }
    if (node.kind === 'function') {
        return `${node.file}#${node.qualifiedName || node.name}`;
    }
    if (node.kind === 'group' || node.kind === 'data') {
        return `${node.file}#${node.name}`;
    }
    return node.file || node.name;
};

const pathOf = node => (node.kind === 'group' ? `${node.file} › ${node.name}` : nodePath(node));

/* "12 files · 48 functions", leaving out what a container has none of. */
export const describeCounts = counts =>
    COUNT_ORDER.filter(kind => counts[kind] > 0)
        .map(kind => `${counts[kind]} ${KIND_PLURALS[kind][counts[kind] === 1 ? 0 : 1]}`)
        .join(' · ');

const WHERE_ORDER = { name: 0, path: 1, source: 2 };

/*
 * A query, as plain text (case-insensitive substring) or as a regular
 * expression. Returns null for an empty query, and an object carrying `error`
 * for a regular expression that does not compile.
 */
export function createMatcher(query, { regex = false } = {}) {
    const text = (query || '').trim();
    if (!text) {
        return null;
    }

    if (!regex) {
        const needle = text.toLowerCase();
        return {
            matches: value =>
                String(value ?? '')
                    .toLowerCase()
                    .includes(needle),
        };
    }

    try {
        const expression = new RegExp(text, 'i');
        return { matches: value => expression.test(String(value ?? '')) };
    } catch (error) {
        return { error: error.message, matches: () => false };
    }
}

/*
 * Everything the query matches: names first, then paths, then function source.
 * Only what the commit selection shows is searched, and a node is reported once,
 * by the most specific thing it matched.
 */
export function searchNodes(index, view, matcher, sourceOf, limit = 200) {
    if (!matcher || matcher.error) {
        return { results: [], total: 0 };
    }
    const results = [];

    for (const node of index.nodes.values()) {
        if (!view.present.has(node.id) || view.hidden?.has(node.id)) {
            continue;
        }
        // An external is not in the tree the results jump around in.
        if (node.kind === 'external') {
            continue;
        }
        const path = nodePath(node);

        if (matcher.matches(node.name)) {
            results.push({ node, path, where: 'name' });
        } else if (matcher.matches(path)) {
            results.push({ node, path, where: 'path' });
        } else if (isLeaf(node)) {
            const hit = matchingLine(sourceOf(node), matcher);
            if (hit) {
                results.push({ node, path, where: 'source', ...hit });
            }
        }
    }

    results.sort(
        (a, b) =>
            WHERE_ORDER[a.where] - WHERE_ORDER[b.where] ||
            (a.node.file || '').localeCompare(b.node.file || '') ||
            (a.node.line || 0) - (b.node.line || 0),
    );

    return { results: results.slice(0, limit), total: results.length };
}

function matchingLine(source, matcher) {
    const lines = (source?.code || '').split('\n');
    const index = lines.findIndex(line => matcher.matches(line));
    if (index === -1) {
        return null;
    }
    return { snippet: lines[index].trim(), line: (source.line || 1) + index };
}

/*
 * The diff the canvas is currently showing, as one hunk per changed function,
 * grouped by the file it lives in. An added function is all additions, a
 * removed one all removals, and a changed one is the base revision against
 * what the commit selection shows.
 */
export function collectDiffHunks(index, view, sourceOf) {
    const hunks = [];

    for (const node of index.nodes.values()) {
        if (!hasSource(node) || !view.present.has(node.id)) {
            continue;
        }
        const status = view.status.get(node.id);
        if (!status) {
            continue;
        }

        const current = sourceOf(node);
        const base = baseSourceOf(node);
        const hunk = hunkFor(node, status, base, current);
        // A hunk of nothing but context is not a hunk.
        // The revision the source came from is the one its lines are blamed at.
        if (hunk.rows.some(row => row.type !== 'context')) {
            hunks.push({ ...hunk, sha: current?.sha || null });
        }
    }

    hunks.sort((a, b) => a.node.file.localeCompare(b.node.file) || a.from - b.from);
    return groupByFile(hunks);
}

function hunkFor(node, status, base, current) {
    const whole = (source, type) => (source?.code || '').split('\n').map(text => ({ type, text }));

    // `from` numbers the side the rows are numbered by; `fromBase` is where the
    // same rows sit in the base revision, which is where a removed line is
    // blamed - it exists nowhere else.
    if (status === 'added') {
        return {
            node,
            status,
            rows: whole(current, 'added'),
            from: current.line || node.line,
            fromBase: null,
            numbering: 'added',
        };
    }
    if (status === 'removed') {
        const source = base || current;
        const from = source?.line || node.line;
        return { node, status, rows: whole(source, 'removed'), from, fromBase: from, numbering: 'removed' };
    }
    // A function whose source is untouched was marked changed by its
    // documentation, which is the diff worth showing for it. Documentation sits
    // above the function, so those rows are left unnumbered.
    if ((base?.code || '') === (current?.code || '')) {
        return {
            node,
            status,
            documentation: true,
            rows: diffLines(base?.doc || '', current?.doc || ''),
            from: null,
            fromBase: null,
            numbering: 'added',
        };
    }

    return {
        node,
        status,
        rows: diffLines(base?.code || '', current?.code || ''),
        from: current?.line || node.line,
        fromBase: base?.line || node.line,
        numbering: 'added',
    };
}

function groupByFile(hunks) {
    const files = new Map();
    for (const hunk of hunks) {
        if (!files.has(hunk.node.file)) {
            files.set(hunk.node.file, []);
        }
        files.get(hunk.node.file).push({ ...hunk, ...countChanges(hunk.rows) });
    }
    return [...files.entries()].map(([file, list]) => ({ file, hunks: list }));
}

/*
 * How many lines the branch added and removed, per node: a function's own diff,
 * and for a class, file or module the sum of everything it holds.
 *
 * This counts what the canvas shows, the way the container tooltip's tally
 * does, so the header and the canvas agree. What a file changed outside its
 * declarations - an import, a comment between two functions - is not in any
 * node, and belongs to the file's own diff instead.
 */
export function diffStats(index, view, sourceOf) {
    const stats = new Map();

    const credit = (id, added, removed) => {
        const total = stats.get(id) || { added: 0, removed: 0 };
        total.added += added;
        total.removed += removed;
        stats.set(id, total);
    };

    for (const node of index.nodes.values()) {
        if (!hasSource(node) || !view.present.has(node.id)) {
            continue;
        }
        const status = view.status.get(node.id);
        if (!status) {
            continue;
        }

        const { added, removed } = countChanges(hunkFor(node, status, baseSourceOf(node), sourceOf(node)).rows);
        if (!added && !removed) {
            continue;
        }

        credit(node.id, added, removed);
        for (const id of ancestors(index, node.id)) {
            credit(id, added, removed);
        }
    }

    return stats;
}

/*
 * The whole diff in lines: every node's own tally, added up.
 *
 * Read off the per-node stats rather than counted again, so the total is the
 * one the canvas is showing - the containers hold sums of these same numbers,
 * and the top of the tree adds up to this.
 */
export function totalDiffStat(index, stats) {
    const total = { added: 0, removed: 0 };
    for (const [id, stat] of stats) {
        // Containers are already carrying their contents' lines; counting them
        // as well would charge every line once per level above it.
        if (!isLeaf(index.nodes.get(id))) {
            continue;
        }
        total.added += stat.added;
        total.removed += stat.removed;
    }
    return total;
}

/*
 * The same view with everything the branch left alone taken out: only functions
 * the selection touched, the containers holding them, and containers the branch
 * added or removed outright. Calls between what remains are kept.
 */
export function restrictToChanges(index, view) {
    const present = new Set();

    const keep = id => {
        present.add(id);
        for (const ancestor of ancestors(index, id)) {
            present.add(ancestor);
        }
    };

    for (const [id, status] of view.status) {
        const node = index.nodes.get(id);
        if (!node || !view.present.has(id)) {
            continue;
        }
        if (isContainer(node) && status !== 'added' && status !== 'removed') {
            continue;
        }
        keep(id);
    }

    // A hidden node stays where it is, so it can be brought back from there.
    for (const id of view.hidden || []) {
        if (view.present.has(id)) {
            keep(id);
        }
    }

    // An added or removed container takes its contents with it.
    for (const id of [...present]) {
        const node = index.nodes.get(id);
        const status = view.status.get(id);
        if (node && isContainer(node) && (status === 'added' || status === 'removed')) {
            keepSubtree(index, view, id, present);
        }
    }

    const edgePresent = new Set(
        index.edges
            .filter(edge => view.edgePresent.has(edge.id) && present.has(edge.source) && present.has(edge.target))
            .map(edge => edge.id),
    );

    return { ...view, present, edgePresent };
}

/*
 * Whether a module or file shows only what is exported: as the reader set it,
 * or the nearest container above it that they set, or as the whole canvas is.
 * `settings` is `{ everywhere, overrides }`, where `overrides` maps the id of a
 * container the reader set one way or the other to how they set it.
 */
export function exportsOnlyAt(index, id, { everywhere, overrides }) {
    for (const current of [id, ...ancestors(index, id)]) {
        if (overrides.has(current)) {
            return overrides.get(current);
        }
    }
    return everywhere;
}

/*
 * The same view with only what is exported left in the modules and files that
 * show only that (see `exportsOnlyAt`): a file keeps the declarations that
 * carry an export tag - including one the selection took out of the interface,
 * since that too is a change to what the file offers - and what they hold, and
 * a file or module left holding nothing goes too. A container the reader set
 * stays, and so does a root or a hidden node, so each can be brought back from
 * where it is.
 */
export function restrictToExports(index, view, { everywhere, overrides }, selected) {
    const present = new Set(view.present);

    const drop = node => {
        present.delete(node.id);
        for (const child of index.children.get(node.id) || []) {
            drop(child);
        }
    };

    // Whether a node is still on the canvas once it is filtered as `inherited`
    // says the container holding it is.
    const filter = (node, inherited) => {
        if (!present.has(node.id)) {
            return false;
        }
        if (index.nodes.get(node.parent)?.kind === 'file') {
            if (!inherited || exportState(node, selected, view.status.get(node.id))) {
                return true;
            }
            drop(node);
            return false;
        }
        if (!isPath(node)) {
            return true;
        }

        const only = overrides.has(node.id) ? overrides.get(node.id) : inherited;
        let holdsAnything = false;
        for (const child of index.children.get(node.id) || []) {
            if (filter(child, only)) {
                holdsAnything = true;
            }
        }
        if (holdsAnything || !only || overrides.has(node.id) || !node.parent || view.hidden?.has(node.id)) {
            return true;
        }
        present.delete(node.id);
        return false;
    };

    for (const root of index.roots) {
        filter(root, everywhere);
    }

    const edgePresent = new Set(
        index.edges
            .filter(edge => view.edgePresent.has(edge.id) && present.has(edge.source) && present.has(edge.target))
            .map(edge => edge.id),
    );
    return { ...view, present, edgePresent };
}

/*
 * The same view with some nodes put back on it, and whatever holds them: the
 * places the reader went to on purpose, which no filter should take away from
 * under them.
 */
export function revealIn(index, view, ids) {
    if (!ids.size) {
        return view;
    }
    const present = new Set(view.present);
    for (const id of ids) {
        if (!index.nodes.has(id)) {
            continue;
        }
        present.add(id);
        for (const ancestor of ancestors(index, id)) {
            present.add(ancestor);
        }
    }
    return { ...view, present };
}

function keepSubtree(index, view, id, present) {
    for (const child of index.children.get(id) || []) {
        if (!view.present.has(child.id)) {
            continue;
        }
        present.add(child.id);
        keepSubtree(index, view, child.id, present);
    }
}

/* The two kinds of change the API list reports. */
export const API_CHANGE_TYPES = ['interface', 'data structure'];

/*
 * What the selected commits do to the *shape* of the code rather than to its
 * workings: signatures, exports, types, and the structures a module declares.
 *
 * A function whose body was rewritten but whose signature still reads the same
 * is not here - that is how it does the job, not what it offers. Neither is a
 * changed scalar. What is here is what a reader of the branch has to know
 * about before reading anything else.
 */
export function collectApiChanges(index, view, sourceOf) {
    const items = [];

    for (const node of index.nodes.values()) {
        if (!view.present.has(node.id)) {
            continue;
        }
        const status = view.status.get(node.id);
        if (!status) {
            continue;
        }

        const change = apiChange(index, node, status, sourceOf);
        if (change) {
            items.push({
                ...change,
                node,
                status,
                path: nodePath(node),
                file: node.file || '',
                line: node.line || 0,
            });
        }
    }

    return items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function apiChange(index, node, status, sourceOf) {
    if (node.kind === 'group') {
        // A class or interface whose members moved is reported by those
        // members; the class itself only matters when it arrives or goes.
        return status === 'changed' ? null : { type: 'interface', detail: [] };
    }
    if (node.kind === 'function') {
        return functionChange(index, node, status, sourceOf);
    }
    if (node.kind === 'data') {
        return dataChange(node, status, sourceOf);
    }
    return null;
}

function functionChange(index, node, status, sourceOf) {
    // A test is not an interface: it is one of the things that uses them.
    if (node.role) {
        return null;
    }
    const base = baseSourceOf(node);
    const current = sourceOf(node);
    const isMember = index.nodes.get(node.parent)?.kind === 'group';

    if (status !== 'changed') {
        // An unexported top-level function is a module's own business.
        if (!node.exported && !isMember) {
            return null;
        }
        const source = status === 'removed' ? base : current;
        return {
            type: 'interface',
            detail: [{ tone: status, text: source?.signature || node.signature || node.name }],
        };
    }

    if (!base || !current) {
        return null;
    }
    if (Boolean(base.exported) !== Boolean(current.exported)) {
        return {
            type: 'interface',
            detail: [{ tone: 'note', text: current.exported ? 'now exported' : 'no longer exported' }],
        };
    }
    if (base.signature && current.signature && base.signature !== current.signature) {
        return {
            type: 'interface',
            detail: [
                { tone: 'removed', text: base.signature },
                { tone: 'added', text: current.signature },
            ],
        };
    }
    return null;
}

function dataChange(node, status, sourceOf) {
    const base = baseSourceOf(node);
    const current = sourceOf(node);

    if (node.dataKind === 'type' || node.dataKind === 'enum') {
        return { type: 'interface', detail: [] };
    }

    const composite = [current?.shape, base?.shape, node.shape].includes('composite');
    if (node.dataKind === 'field' || composite) {
        return { type: 'data structure', detail: status === 'changed' ? keyChanges(base, current) : [] };
    }

    // A scalar the module keeps to itself, or a value moving: the how.
    return status !== 'changed' && node.exported ? { type: 'interface', detail: [] } : null;
}

/* Which parts of a structure came and went, when they can be named. */
function keyChanges(base, current) {
    const before = base?.keys || null;
    const after = current?.keys || null;
    if (!before || !after) {
        return [{ tone: 'note', text: 'contents changed' }];
    }

    const added = after.filter(key => !before.includes(key));
    const removed = before.filter(key => !after.includes(key));
    if (!added.length && !removed.length) {
        return [{ tone: 'note', text: 'contents changed' }];
    }

    return [
        ...(removed.length ? [{ tone: 'removed', text: removed.join(', ') }] : []),
        ...(added.length ? [{ tone: 'added', text: added.join(', ') }] : []),
    ];
}

/* How many of each type a change list holds, for its filters. */
export function countByType(items) {
    const counts = new Map();
    for (const item of items) {
        counts.set(item.type, (counts.get(item.type) || 0) + 1);
    }
    return counts;
}

/*
 * The files on the canvas, as a tree of the directories holding them. With a
 * branch loaded it holds only the files that branch touched - the ones worth
 * opening - and otherwise every file that was analysed.
 */
export function buildFileTree(index, view, { changedOnly = false } = {}) {
    const walk = node => {
        if (!view.present.has(node.id)) {
            return null;
        }

        if (node.kind === 'file') {
            const status = view.status.get(node.id) || null;
            if (changedOnly && !status) {
                return null;
            }
            return {
                id: node.id,
                name: node.name,
                kind: 'file',
                status,
                title: node.file,
                children: touchedUnder(index, view, node.id),
            };
        }
        if (node.kind !== 'module') {
            return null;
        }

        const children = (index.children.get(node.id) || []).map(walk).filter(Boolean);
        if (!children.length) {
            return null;
        }
        return {
            id: node.id,
            name: node.name,
            kind: 'dir',
            status: view.status.get(node.id) || null,
            title: node.id.replace(/^module:/, ''),
            children: children.sort(byTreeOrder),
        };
    };

    return index.roots.map(walk).filter(Boolean).sort(byTreeOrder);
}

/*
 * What the diff touched inside a file, in the shape it is declared in: a
 * changed function on its own, a class holding the methods that changed, in
 * source order. With no diff loaded nothing is touched and a file holds
 * nothing, which is why the tree only opens up once there is a diff to read.
 */
function touchedUnder(index, view, id) {
    const kept = [];

    for (const child of [...(index.children.get(id) || [])].sort(bySourceLine)) {
        if (!view.present.has(child.id)) {
            continue;
        }

        const children = touchedUnder(index, view, child.id);
        const status = view.status.get(child.id) || null;
        if (!status && !children.length) {
            continue;
        }

        kept.push({
            id: child.id,
            name: displayName(child),
            kind: isLeaf(child) ? 'leaf' : 'group',
            status,
            title: `${child.file}:${child.line}`,
            children,
        });
    }

    return kept;
}

const bySourceLine = (a, b) => (a.line || 0) - (b.line || 0);

const byTreeOrder = (a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || a.name.localeCompare(b.name);

/* How many files a tree holds. */
export function countFiles(tree) {
    return tree.reduce((total, node) => total + (node.kind === 'file' ? 1 : countFiles(node.children)), 0);
}
