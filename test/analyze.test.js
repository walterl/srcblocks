import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCallGraph } from '#srcblocks/analyze/graph.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sample');

describe('buildCallGraph', () => {
    const graph = buildCallGraph({ rootDir });
    const nodeIds = graph.nodes.map(node => node.id);
    const edgeIds = graph.edges.map(edge => edge.id);
    const nodeById = id => graph.nodes.find(node => node.id === id);

    it('nests functions in their file and module', () => {
        expect(nodeIds).toEqual(
            expect.arrayContaining([
                'module:src',
                'module:src/lib',
                'file:src/util.js',
                'func:src/util.js#helper',
                'func:src/util.js#arrow',
            ]),
        );
        expect(nodeById('file:src/util.js').parent).toBe('module:src');
        expect(nodeById('module:src/lib').parent).toBe('module:src');
        expect(nodeById('func:src/util.js#helper').parent).toBe('file:src/util.js');
    });

    it('groups methods under their class', () => {
        expect(nodeById('group:src/lib/Service.js#Service')).toMatchObject({
            kind: 'group',
            groupKind: 'class',
            parent: 'file:src/lib/Service.js',
        });
        expect(nodeById('func:src/lib/Service.js#Service.run').parent).toBe('group:src/lib/Service.js#Service');
    });

    it('keeps the documentation and source of a function', () => {
        const helper = nodeById('func:src/util.js#helper');
        expect(helper.doc).toBe('/** Doubles a number. */');
        expect(helper.code).toContain('return value * 2;');
        expect(helper.line).toBe(2);
    });

    it('resolves calls across files, methods and constructors', () => {
        expect(edgeIds).toEqual(
            expect.arrayContaining([
                'call:func:src/util.js#arrow->func:src/util.js#helper',
                'call:func:src/lib/Service.js#Service.run->func:src/util.js#helper',
                'call:func:src/lib/Service.js#Service.run->func:src/lib/Service.js#Service.countdown',
                'call:func:src/main.js#main->func:src/lib/Service.js#Service.constructor',
                'call:func:src/main.js#main->func:src/lib/Service.js#Service.run',
                'call:func:src/main.js#main->func:src/util.js#arrow',
            ]),
        );
    });

    it('marks a recursive call as an edge onto itself', () => {
        const recursive = graph.edges.find(edge => edge.source === 'func:src/lib/Service.js#Service.countdown');
        expect(recursive).toMatchObject({ target: 'func:src/lib/Service.js#Service.countdown', recursive: true });
    });

    it('ignores calls that leave the analysed sources', () => {
        expect(edgeIds.some(id => id.includes('console'))).toBe(false);
        expect(graph.stats.resolved).toBeGreaterThan(0);
    });
});
