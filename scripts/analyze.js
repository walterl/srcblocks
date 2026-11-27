#!/usr/bin/env node
/*
 * Ad-hoc analyser run: `npm run analyze -- <repo-dir> [includePrefix ...]`
 * Prints graph statistics and a sample of resolved edges.
 */
import { buildCallGraph } from '#srcblocks/analyze/graph.js';

const [rootDir, ...include] = process.argv.slice(2);
if (!rootDir) {
    console.error('usage: npm run analyze -- <repo-dir> [includePrefix ...]');
    process.exit(1);
}

const started = Date.now();
const graph = buildCallGraph({ rootDir, include: include.length ? include : null });
console.log(JSON.stringify(graph.stats, null, 2));
console.log(`took ${Date.now() - started}ms`);

const { typed, untyped, access } = graph.stats.flows;
console.log(`flows: ${typed} typed, ${untyped} untyped, ${access} access edges`);

const named = kind =>
    graph.nodes.filter(node => node.kind === 'external' && node.externalKind === kind).map(node => node.name);
const sample = names => (names.length ? ` (${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''})` : '');
const services = named('service');
const libraries = named('library');
console.log(
    `externals: ${services.length} services${sample(services)}, ` + `${libraries.length} libraries${sample(libraries)}`,
);
console.log('sample edges:');
for (const edge of graph.edges.slice(0, 15)) {
    console.log(`  ${edge.source} -> ${edge.target} (${edge.callCount})`);
}
