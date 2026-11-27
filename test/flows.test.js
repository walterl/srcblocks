import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCallGraph } from '#srcblocks/analyze/graph.js';
import { incomingCalls, indexGraph, isContainer, outgoingCalls } from '../src/app/public/model.js';
import { buildRenderPlan } from '../src/app/public/viewmodel.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const graphOf = name => buildCallGraph({ rootDir: path.join(fixtures, name) });

const ts = graphOf('flows-ts');
const js = graphOf('flows-js');

const nodeById = (graph, id) => graph.nodes.find(node => node.id === id);
const edgeById = (graph, id) => graph.edges.find(edge => edge.id === id);
const carriesOf = (graph, id) => edgeById(graph, id)?.carries;

describe('carried types', () => {
    it('resolves a named type to the node that declares it', () => {
        const carries = carriesOf(ts, 'call:func:src/api.ts#handle->func:src/service.ts#place');
        expect(carries.in).toEqual([{ ref: 'group:src/types.ts#Order', text: 'Order', external: false }]);
    });

    it('unwraps a promise, since when a value arrives is not what it is', () => {
        const carries = carriesOf(ts, 'call:func:src/api.ts#handle->func:src/service.ts#place');
        expect(carries.out).toEqual([{ ref: 'group:src/types.ts#Order', text: 'Order', external: false }]);
    });

    it('keeps an array reading as an array while pointing at its element', () => {
        const carries = carriesOf(ts, 'call:func:src/service.ts#place->func:src/repo.ts#all');
        expect(carries.out).toEqual([{ ref: 'group:src/types.ts#Order', text: 'Order[]', external: false }]);
    });

    it('drops the absent half of `Order | null`', () => {
        const carries = carriesOf(ts, 'call:func:src/service.ts#place->func:src/repo.ts#find');
        expect(carries.out).toEqual([{ ref: 'group:src/types.ts#Order', text: 'Order', external: false }]);
    });

    it('keeps a named union whole and resolves it to its type alias', () => {
        const carries = carriesOf(ts, 'call:func:src/service.ts#place->func:src/service.ts#statusOf');
        expect(carries.out).toEqual([{ ref: 'data:src/types.ts#Status', text: 'Status', external: false }]);
    });

    it('inlines the members of an anonymous object type', () => {
        const carries = carriesOf(ts, 'call:func:src/service.ts#place->func:src/repo.ts#summary');
        expect(carries.out).toEqual([
            {
                ref: null,
                text: '{ count: number; total: number; }',
                external: false,
                members: [
                    { name: 'count', type: 'number' },
                    { name: 'total', type: 'number' },
                ],
            },
        ]);
    });

    it('marks a primitive as one and attributes it to the lib', () => {
        const carries = carriesOf(ts, 'call:func:src/service.ts#place->func:src/repo.ts#find');
        expect(carries.in).toEqual([{ ref: null, text: 'string', external: 'lib', primitive: true }]);
    });
});

describe('carried types in JavaScript', () => {
    it('resolves a JSDoc typedef to the node that declares it', () => {
        const order = 'data:src/types.js#Order';
        const carries = carriesOf(js, 'call:func:src/api.js#handle->func:src/service.js#place');
        expect(carries.untyped).toBe(false);
        expect(carries.in).toEqual([{ ref: order, text: 'Order', external: false }]);
        expect(nodeById(js, order).members).toEqual([
            { name: 'id', type: 'string' },
            { name: 'total', type: 'number' },
        ]);
    });

    it('marks a call with nothing but `any` on it as untyped', () => {
        const carries = carriesOf(js, 'call:func:src/repo.js#touch->func:src/repo.js#save');
        expect(carries.untyped).toBe(true);
        expect(carries.in).toEqual([{ ref: null, text: 'any', external: false, untyped: true }]);
    });
});

describe('members of a type-like node', () => {
    it('records what an interface declares', () => {
        expect(nodeById(ts, 'group:src/types.ts#Order').members).toEqual([
            { name: 'id', type: 'string' },
            { name: 'total', type: 'number' },
            { name: 'lines', type: 'Line[]' },
        ]);
    });

    it('leaves a union of literals without members of its own', () => {
        expect(nodeById(ts, 'data:src/types.ts#Status').members).toBeUndefined();
    });
});

describe('externals', () => {
    const external = id => nodeById(ts, id);

    it('names a package from its import specifier, unresolved as it is', () => {
        expect(external('ext:pkg:pg')).toMatchObject({
            kind: 'external',
            name: 'pg',
            externalKind: 'service',
            package: 'pg',
            host: null,
            parent: null,
        });
        expect(edgeById(ts, 'call:func:src/repo.ts#save->ext:pkg:pg')).toMatchObject({ kind: 'call', callCount: 1 });
    });

    it('reads a package out of a `require` call too', () => {
        expect(nodeById(js, 'ext:pkg:pg')).toMatchObject({ externalKind: 'service' });
    });

    it('separates a builtin that computes from one that does I/O', () => {
        expect(external('ext:pkg:node:path')).toMatchObject({ externalKind: 'library', package: 'node:path' });
    });

    it('names the host a literal URL points at rather than the client', () => {
        expect(external('ext:host:api.example.com')).toMatchObject({
            externalKind: 'service',
            host: 'api.example.com',
            package: 'fetch',
        });
    });

    it('makes no node out of a lib global, which is not a boundary', () => {
        const sample = graphOf('sample');
        expect(sample.nodes.some(node => node.kind === 'external')).toBe(false);
        expect(sample.stats.externals).toEqual({ service: 0, library: 0 });
    });
});

describe('access edges', () => {
    it('records a read of another file’s exported constant', () => {
        const edge = edgeById(ts, 'access:func:src/service.ts#place->data:src/config.ts#LIMITS');
        expect(edge).toMatchObject({ kind: 'access', mode: 'read', callCount: 1 });
        expect(edge.carries.out.length).toBeGreaterThan(0);
        expect(edge.carries.in).toEqual([]);
    });

    it('records a write as a write', () => {
        const edge = edgeById(ts, 'access:func:src/service.ts#place->data:src/config.ts#counter');
        expect(edge).toMatchObject({ kind: 'access', mode: 'write' });
        expect(edge.carries.in.length).toBeGreaterThan(0);
    });

    it('records what a file reads of the data it declares itself', () => {
        const own = ts.edges.filter(
            edge =>
                edge.kind === 'access' &&
                edge.source.startsWith('func:src/repo.ts') &&
                edge.target === 'data:src/repo.ts#pool',
        );
        expect(own.map(edge => edge.source)).toEqual([
            'func:src/repo.ts#save',
            'func:src/repo.ts#find',
            'func:src/repo.ts#all',
        ]);
    });
});

describe('stats', () => {
    it('counts external nodes and the flow of every edge', () => {
        expect(ts.stats.externals).toEqual({ service: 2, library: 1 });
        // Two constants read across a file boundary, and one read three times
        // by the file that declares it.
        expect(ts.stats.flows.access).toBe(5);
        expect(ts.stats.flows.typed).toBeGreaterThan(0);
        expect(js.stats.flows.untyped).toBeGreaterThan(0);
    });
});

/*
 * Flows add nodes and edges to the same graph call mode draws, so every call
 * call mode drew has to come out of it unchanged - with what reaches a constant
 * drawn beside them, and marked as the different thing it is.
 */
describe('call mode', () => {
    const planOf = graph => {
        const index = indexGraph(graph);
        const view = {
            present: new Set(graph.nodes.map(node => node.id)),
            status: new Map(),
            edgePresent: new Set(graph.edges.map(edge => edge.id)),
            edgeStatus: new Map(),
        };
        const expanded = new Set(graph.nodes.filter(isContainer).map(node => node.id));
        return buildRenderPlan(index, view, expanded);
    };

    it('draws every call it drew before flows were analysed', () => {
        const withoutFlows = {
            nodes: ts.nodes.filter(node => node.kind !== 'external'),
            edges: ts.edges.filter(edge => edge.kind === 'call' && !edge.target.startsWith('ext:')),
        };
        const plan = planOf(ts);
        const before = planOf(withoutFlows);

        expect(JSON.stringify(plan.drawn)).toEqual(JSON.stringify(before.drawn));
        expect(plan.edges.filter(edge => !edge.access)).toEqual(before.edges);
    });

    it('draws what reaches a constant as well, told apart from the calls', () => {
        const reads = planOf(ts).edges.filter(edge => edge.access);
        expect(reads.map(edge => edge.id)).toContain('func:src/service.ts#place->data:src/config.ts#LIMITS');
        expect(reads.map(edge => edge.id)).toContain('func:src/repo.ts#save->data:src/repo.ts#pool');
    });

    it('lists what a function calls and what it reaches, without its packages', () => {
        const index = indexGraph(ts);
        const view = {
            present: new Set(ts.nodes.map(node => node.id)),
            status: new Map(),
            edgePresent: new Set(ts.edges.map(edge => edge.id)),
            edgeStatus: new Map(),
        };
        const called = outgoingCalls(index, view, 'func:src/service.ts#place');
        expect(called.map(call => call.node.id)).toEqual([
            'data:src/config.ts#LIMITS',
            'data:src/config.ts#counter',
            'func:src/repo.ts#save',
            'func:src/repo.ts#summary',
            'func:src/repo.ts#all',
            'func:src/service.ts#statusOf',
            'func:src/repo.ts#find',
        ]);
        // A reference says which it is; a call says nothing, being the default.
        expect(called.map(call => call.access)).toEqual(['read', 'write', null, null, null, null, null]);
    });

    it('lists what reaches a constant as what calls it', () => {
        const index = indexGraph(ts);
        const view = {
            present: new Set(ts.nodes.map(node => node.id)),
            status: new Map(),
            edgePresent: new Set(ts.edges.map(edge => edge.id)),
            edgeStatus: new Map(),
        };
        const readers = incomingCalls(index, view, 'data:src/repo.ts#pool');
        expect(readers.map(call => call.node.id)).toEqual([
            'func:src/repo.ts#save',
            'func:src/repo.ts#find',
            'func:src/repo.ts#all',
        ]);
    });
});
