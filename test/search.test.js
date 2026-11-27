import { createMatcher, indexGraph, searchNodes } from '../src/app/public/model.js';

const graph = {
    nodes: [
        { id: 'module:src/lib', kind: 'module', name: 'lib', path: 'src/lib', parent: null, inBase: true },
        {
            id: 'file:src/lib/price.js',
            kind: 'file',
            name: 'price.js',
            file: 'src/lib/price.js',
            parent: 'module:src/lib',
            inBase: true,
        },
        {
            id: 'fn:convert',
            kind: 'function',
            name: 'convert',
            qualifiedName: 'convert',
            file: 'src/lib/price.js',
            line: 10,
            parent: 'file:src/lib/price.js',
            code: 'function convert(value) {\n    return value * RATE;\n}',
            inBase: true,
        },
        {
            id: 'fn:hidden',
            kind: 'function',
            name: 'hidden',
            qualifiedName: 'hidden',
            file: 'src/lib/price.js',
            line: 30,
            parent: 'file:src/lib/price.js',
            code: 'function hidden() {\n    return RATE;\n}',
            inBase: true,
        },
    ],
    edges: [],
};

const index = indexGraph(graph);
const view = { present: new Set(index.nodes.keys()), status: new Map(), edgePresent: new Set(), edgeStatus: new Map() };
const sourceOf = node => ({ code: node.code, line: node.line });
const find = (query, options) => searchNodes(index, view, createMatcher(query, options), sourceOf);

describe('search', () => {
    it('matches names, whatever the case', () => {
        expect(find('CONVERT').results.map(r => [r.node.id, r.where])).toEqual([['fn:convert', 'name']]);
    });

    it('matches paths', () => {
        expect(
            find('lib/price')
                .results.map(r => r.node.id)
                .sort(),
        ).toEqual(['file:src/lib/price.js', 'fn:convert', 'fn:hidden']);
    });

    it('matches inside a function and reports the line it found', () => {
        expect(find('value * RATE').results).toEqual([
            expect.objectContaining({
                where: 'source',
                snippet: 'return value * RATE;',
                line: 11,
                path: 'src/lib/price.js#convert',
            }),
        ]);
    });

    it('reports a node once, by the most specific thing it matched', () => {
        const results = find('convert').results.filter(result => result.node.id === 'fn:convert');
        expect(results).toHaveLength(1);
        expect(results[0].where).toBe('name');
    });

    it('puts name matches before path and source matches', () => {
        expect(find('RATE').results.map(r => r.where)).toEqual(['source', 'source']);
        expect(find('price').results.map(r => r.where)[0]).toBe('name');
    });

    it('takes a regular expression', () => {
        expect(find('^conv', { regex: true }).results.map(r => r.node.id)).toEqual(['fn:convert']);
        expect(find('hid+en', { regex: true }).results.map(r => r.node.id)).toEqual(['fn:hidden']);
    });

    it('reports a broken regular expression instead of throwing', () => {
        const matcher = createMatcher('conv(', { regex: true });
        expect(matcher.error).toEqual(expect.any(String));
        expect(searchNodes(index, view, matcher, sourceOf).results).toEqual([]);
    });

    it('has nothing to say about an empty query', () => {
        expect(createMatcher('   ')).toBe(null);
        expect(searchNodes(index, view, null, sourceOf)).toEqual({ results: [], total: 0 });
    });

    it('searches only what the commit selection shows', () => {
        const partial = { ...view, present: new Set(['fn:hidden']) };
        expect(
            searchNodes(partial && index, partial, createMatcher('RATE'), sourceOf).results.map(r => r.node.id),
        ).toEqual(['fn:hidden']);
    });

    it('caps the list but reports the true total', () => {
        const capped = searchNodes(index, view, createMatcher('price'), sourceOf, 1);
        expect(capped.results).toHaveLength(1);
        expect(capped.total).toBe(3);
    });
});
