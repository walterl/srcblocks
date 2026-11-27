import { listCommits, mergeBase, resolveRef } from '#srcblocks/git/repo.js';
import { graphForRev } from '#srcblocks/analyze/revision.js';
import { diffGraphs } from '#srcblocks/analyze/diff.js';

/*
 * Analyses a branch as a chain of per-commit graph diffs.
 *
 * Every commit is measured against its own first parent, so a commit's diff
 * describes exactly what that commit did - independent of which other commits
 * are selected. That is what lets the UI recompute the picture on (de)selection
 * without re-analysing anything.
 *
 * The canvas needs every node and edge that any selection could show, so the
 * returned graph is the union of the base revision and of every revision on the
 * branch; `inBase` marks what already existed before the branch.
 */
export async function analyzeBranch({ repoDir, branch, baseRef, include = null, onProgress = () => {} }) {
    const baseSha = await mergeBase(repoDir, baseRef, branch);
    const headSha = await resolveRef(repoDir, branch);
    const commits = await listCommits(repoDir, baseSha, branch);

    onProgress({ step: 0, total: commits.length + 1, label: `base ${baseSha.slice(0, 7)}` });
    const union = createUnion(await graphForRev(repoDir, baseSha, { include }));
    const perCommit = {};

    for (const [index, commit] of commits.entries()) {
        onProgress({ step: index + 1, total: commits.length + 1, label: `${commit.shortSha} ${commit.subject}` });
        const before = await graphForRev(repoDir, commit.parent, { include });
        const after = await graphForRev(repoDir, commit.sha, { include });
        const diff = diffGraphs(before, after);
        perCommit[commit.sha] = diff;
        union.merge(before);
        union.merge(after);
        union.recordVersions(after, commit.sha, diff.nodes);
    }

    return {
        branch,
        base: { ref: baseRef, sha: baseSha },
        head: { ref: branch, sha: headSha },
        commits,
        perCommit,
        graph: union.result(),
    };
}

/*
 * Accumulates the union of a chain of graphs.
 *
 * A function's - or a constant's - source is not a single value on the branch: the canvas shows the
 * version produced by the newest selected commit, and compares it with the one
 * the base revision had. Function nodes therefore carry `base` (their source
 * before the branch) and `versions` (one entry per commit that added or changed
 * them) instead of one source, and the client picks from those.
 */
function createUnion(baseGraph) {
    const nodes = new Map();
    const edges = new Map();
    const base = new Map();
    const versions = new Map();

    const mergeInto = (map, items, inBase) => {
        for (const item of items) {
            const existing = map.get(item.id);
            map.set(item.id, { ...item, inBase: existing ? existing.inBase : inBase });
        }
    };

    // `line` travels with the source: a version's line numbers are the ones it
    // had in its own revision, which is what the diff views count from.
    const hasSource = node => node.kind === 'function' || node.kind === 'data';
    // What the node was in that revision, not just how it read: the signature a
    // caller sees, whether it was exported, the shape of the value it holds,
    // the members it declares, and what it called and carried - so that the
    // calls a revision makes can be compared the same way its source is. Where
    // its names are defined is read off the same code, so it goes with it.
    const sourceOf = (node, calls) => ({
        calls: calls.get(node.id) || [],
        code: node.code || '',
        refs: node.refs || [],
        doc: node.doc || null,
        hash: node.hash,
        line: node.line,
        signature: node.signature,
        exported: Boolean(node.exported),
        shape: node.shape,
        keys: node.keys,
        members: node.members,
    });

    // Every kind of edge, not only calls: what a function reads or writes of
    // another file's data appears and disappears the same way a call does.
    const callTargets = graph => {
        const targets = new Map();
        for (const edge of graph.edges) {
            if (!targets.has(edge.source)) {
                targets.set(edge.source, []);
            }
            targets.get(edge.source).push({ target: edge.target, carries: edge.carries || null });
        }
        return targets;
    };

    mergeInto(nodes, baseGraph.nodes, true);
    mergeInto(edges, baseGraph.edges, true);
    const baseCalls = callTargets(baseGraph);
    for (const node of baseGraph.nodes) {
        if (hasSource(node)) {
            base.set(node.id, sourceOf(node, baseCalls));
        }
    }

    return {
        merge(graph) {
            mergeInto(nodes, graph.nodes, false);
            mergeInto(edges, graph.edges, false);
        },

        /* Keeps the source a commit gave every function it touched. */
        recordVersions(graph, sha, nodeStatuses) {
            const calls = callTargets(graph);
            for (const node of graph.nodes) {
                if (!hasSource(node)) {
                    continue;
                }
                const status = nodeStatuses[node.id];
                if (status !== 'added' && status !== 'changed') {
                    continue;
                }
                if (!versions.has(node.id)) {
                    versions.set(node.id, []);
                }
                versions.get(node.id).push({ sha, ...sourceOf(node, calls) });
            }
        },

        result: () => ({
            nodes: [...nodes.values()].map(node => {
                if (!hasSource(node)) {
                    return node;
                }
                const { code, doc, refs, ...rest } = node;
                // Kept as the base for nodes that only ever existed on a
                // revision the branch neither starts from nor changes.
                const fallback = { ...sourceOf(node, new Map()), calls: null };
                return {
                    ...rest,
                    base: base.get(node.id) || (versions.has(node.id) ? null : fallback),
                    versions: versions.get(node.id) || [],
                };
            }),
            edges: [...edges.values()],
        }),
    };
}
