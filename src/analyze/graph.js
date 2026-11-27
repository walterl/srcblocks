import path from 'node:path';
import { createProgram } from '#srcblocks/analyze/program.js';
import { collectDeclarations, moduleId } from '#srcblocks/analyze/collect.js';
import { resolveCalls } from '#srcblocks/analyze/calls.js';
import { attachReferences } from '#srcblocks/analyze/references.js';
import { attachCarries, attachMembers, flowStats, resolveAccesses } from '#srcblocks/analyze/flows.js';

/*
 * Builds the call graph for a source tree.
 *
 * `include` limits which files become graph nodes (e.g. ['src']); every file is
 * still parsed so that call targets resolve across the whole tree.
 *
 * Calls come first, because what flows along them is read off their call sites:
 * the types a call carries, the shape of the types themselves, and what a
 * function reads or writes of the data another file declares.
 */
export function buildCallGraph({ rootDir, include = null }) {
    const { program, checker, sourceFiles } = createProgram(rootDir);
    const selected = include ? sourceFiles.filter(file => isIncluded(file.fileName, rootDir, include)) : sourceFiles;

    const collected = collectDeclarations(selected, rootDir);
    const { edges: callEdges, stats, sitesByEdge, externals } = resolveCalls(collected, checker, program);

    const flowOptions = { typeIdByDeclaration: collected.typeIdByDeclaration, program };
    attachCarries(callEdges, sitesByEdge, checker, flowOptions);
    attachMembers(collected.nodes, collected.typeIdByDeclaration, checker);
    const accessEdges = resolveAccesses(collected, checker, flowOptions);
    attachReferences(collected, checker, { rootDir, sourceFiles: selected });

    const edges = [...callEdges, ...accessEdges];
    // Externals last: they belong to no file, so they are roots of their own and
    // the canvas draws them outside the tree.
    const nodes = [...moduleNodes(collected.nodes), ...collected.nodes, ...externals.values()];

    return {
        nodes,
        edges,
        stats: {
            ...stats,
            flows: flowStats(edges),
            files: selected.length,
            nodes: nodes.length,
            edges: edges.length,
        },
    };
}

function isIncluded(fileName, rootDir, include) {
    const rel = path.relative(rootDir, fileName).split(path.sep).join('/');
    return include.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`));
}

/*
 * Derives the directory (module) nodes that own the collected file nodes, so
 * that files nest inside their module and modules inside their parent module.
 */
function moduleNodes(nodes) {
    const directories = new Set();
    for (const node of nodes) {
        if (node.kind !== 'file') {
            continue;
        }
        let dir = path.posix.dirname(node.file);
        while (dir && dir !== '.') {
            directories.add(dir);
            dir = path.posix.dirname(dir);
        }
    }

    return [...directories].sort().map(dir => {
        const parent = path.posix.dirname(dir);
        return {
            id: moduleId(dir),
            kind: 'module',
            name: path.posix.basename(dir),
            path: dir,
            parent: parent === '.' ? null : moduleId(parent),
        };
    });
}
