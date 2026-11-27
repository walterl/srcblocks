import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCallGraph } from '#srcblocks/analyze/graph.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/* A node's references, each with the text it covers in the node's own code. */
const referencesOf = (graph, id) => {
    const node = graph.nodes.find(candidate => candidate.id === id);
    const lines = node.code.split('\n');
    return node.refs.map(([line, column, length, ...target]) => [
        lines[line].slice(column, column + length),
        ...target,
    ]);
};

describe('references', () => {
    const sample = buildCallGraph({ rootDir: path.join(fixtures, 'sample') });

    it('follows an import to the node it imports', () => {
        expect(referencesOf(sample, 'func:src/main.js#main')).toEqual(
            expect.arrayContaining([
                ['Service', 'group:src/lib/Service.js#Service'],
                ['run', 'func:src/lib/Service.js#Service.run'],
                ['arrow', 'func:src/util.js#arrow'],
            ]),
        );
    });

    it('places a local in the node that declares it, at its line', () => {
        expect(referencesOf(sample, 'func:src/main.js#main')).toContainEqual(['service', 'func:src/main.js#main', 5]);
    });

    it('positions the first line of an indented declaration within its own code', () => {
        const run = referencesOf(sample, 'func:src/lib/Service.js#Service.run');
        expect(run).toContainEqual(['helper', 'func:src/util.js#helper']);
        expect(run).toContainEqual(['countdown', 'func:src/lib/Service.js#Service.countdown']);
    });

    const config = buildCallGraph({ rootDir: path.join(fixtures, 'references') });
    const read = referencesOf(config, 'func:src/config.js#read');

    it('places what no node holds in its file', () => {
        expect(read).toContainEqual(['level', 'file:src/config.js', 1]);
    });

    it('leaves out declaration names and what the tree does not define', () => {
        const names = read.map(([name]) => name);
        expect(names).not.toContain('read');
        expect(names).not.toContain('Math');
        expect(names).not.toContain('min');
        expect(names.filter(name => name === 'limit')).toHaveLength(1);
    });

    it('only positions references inside the displayed source, excluding leading JSDoc', () => {
        const graph = buildCallGraph({ rootDir: path.join(fixtures, 'flows-js') });
        const refs = referencesOf(graph, 'func:src/api.js#handle');
        expect(refs).toContainEqual(['place', 'func:src/service.js#place']);
        expect(refs.map(([name]) => name)).not.toContain('Order');
    });
});
