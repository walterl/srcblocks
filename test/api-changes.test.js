import { collectApiChanges, countByType, indexGraph } from '../src/app/public/model.js';

const base = (extra = {}) => ({ code: 'old', hash: 'a', line: 1, exported: true, ...extra });
const version = (sha, extra = {}) => ({ sha, code: 'new', hash: 'b', line: 1, exported: true, ...extra });

const graph = {
    nodes: [
        { id: 'file:a.js', kind: 'file', name: 'a.js', file: 'a.js', parent: null, inBase: true },
        {
            id: 'group:a.js#Crawler',
            kind: 'group',
            groupKind: 'class',
            name: 'Crawler',
            file: 'a.js',
            line: 5,
            parent: 'file:a.js',
            inBase: true,
        },
        {
            id: 'func:a.js#Crawler.run',
            kind: 'function',
            name: 'run',
            file: 'a.js',
            line: 6,
            parent: 'group:a.js#Crawler',
            signature: 'run(job, options)',
            base: base({ signature: 'run(job)' }),
            versions: [version('c1', { signature: 'run(job, options)' })],
            inBase: true,
        },
        {
            id: 'func:a.js#rewritten',
            kind: 'function',
            name: 'rewritten',
            file: 'a.js',
            line: 20,
            parent: 'file:a.js',
            exported: true,
            signature: 'rewritten(value)',
            base: base({ signature: 'rewritten(value)' }),
            versions: [version('c1', { signature: 'rewritten(value)' })],
            inBase: true,
        },
        {
            id: 'func:a.js#unexported',
            kind: 'function',
            name: 'unexported',
            file: 'a.js',
            line: 30,
            parent: 'file:a.js',
            exported: false,
            signature: 'unexported()',
            base: null,
            versions: [version('c1', { signature: 'unexported()', exported: false })],
            inBase: false,
        },
        {
            id: 'func:a.js#hidden',
            kind: 'function',
            name: 'hidden',
            file: 'a.js',
            line: 40,
            parent: 'file:a.js',
            exported: false,
            signature: 'hidden()',
            base: base({ signature: 'hidden()', exported: true }),
            versions: [version('c1', { signature: 'hidden()', exported: false })],
            inBase: true,
        },
        {
            id: 'data:a.js#TABLE',
            kind: 'data',
            dataKind: 'constant',
            shape: 'composite',
            name: 'TABLE',
            file: 'a.js',
            line: 50,
            parent: 'file:a.js',
            exported: true,
            base: base({ shape: 'composite', keys: ['btc', 'eth', 'legacy'] }),
            versions: [version('c1', { shape: 'composite', keys: ['btc', 'eth', 'sol'] })],
            inBase: true,
        },
        {
            id: 'data:a.js#TIMEOUT',
            kind: 'data',
            dataKind: 'constant',
            shape: 'scalar',
            name: 'TIMEOUT',
            file: 'a.js',
            line: 60,
            parent: 'file:a.js',
            exported: true,
            base: base({ shape: 'scalar' }),
            versions: [version('c1', { shape: 'scalar' })],
            inBase: true,
        },
        {
            id: 'data:a.js#Crawler.retries',
            kind: 'data',
            dataKind: 'field',
            shape: 'scalar',
            name: 'retries',
            file: 'a.js',
            line: 7,
            parent: 'group:a.js#Crawler',
            base: base({ shape: 'scalar' }),
            versions: [version('c1', { shape: 'scalar' })],
            inBase: true,
        },
    ],
    edges: [],
};

const index = indexGraph(graph);
const view = {
    present: new Set(index.nodes.keys()),
    status: new Map([
        ['func:a.js#Crawler.run', 'changed'],
        ['func:a.js#rewritten', 'changed'],
        ['func:a.js#unexported', 'added'],
        ['func:a.js#hidden', 'changed'],
        ['data:a.js#TABLE', 'changed'],
        ['data:a.js#TIMEOUT', 'changed'],
        ['data:a.js#Crawler.retries', 'changed'],
        ['group:a.js#Crawler', 'changed'],
        ['file:a.js', 'changed'],
    ]),
    edgePresent: new Set(),
    edgeStatus: new Map(),
};

const sourceOf = node => (node.versions?.length ? node.versions.at(-1) : node.base);
const items = collectApiChanges(index, view, sourceOf);
const find = id => items.find(item => item.node.id === id);

describe('collectApiChanges', () => {
    it('reports a changed signature, before and after', () => {
        expect(find('func:a.js#Crawler.run')).toMatchObject({
            type: 'interface',
            detail: [
                { tone: 'removed', text: 'run(job)' },
                { tone: 'added', text: 'run(job, options)' },
            ],
        });
    });

    it('says nothing about a function that was only rewritten', () => {
        expect(find('func:a.js#rewritten')).toBeUndefined();
    });

    it('reports an export being withdrawn', () => {
        expect(find('func:a.js#hidden')).toMatchObject({
            type: 'interface',
            detail: [{ tone: 'note', text: 'no longer exported' }],
        });
    });

    it('leaves a module’s own helpers out', () => {
        expect(find('func:a.js#unexported')).toBeUndefined();
    });

    it('names the parts of a structure that came and went', () => {
        expect(find('data:a.js#TABLE')).toMatchObject({
            type: 'data structure',
            detail: [
                { tone: 'removed', text: 'legacy' },
                { tone: 'added', text: 'sol' },
            ],
        });
    });

    it('treats a class field as part of the structure', () => {
        expect(find('data:a.js#Crawler.retries')).toMatchObject({ type: 'data structure' });
    });

    it('says nothing about a scalar whose value moved', () => {
        expect(find('data:a.js#TIMEOUT')).toBeUndefined();
    });

    it('leaves out a class whose members carry the change, and the file', () => {
        expect(find('group:a.js#Crawler')).toBeUndefined();
        expect(find('file:a.js')).toBeUndefined();
    });

    it('orders items as the diff does and counts the two types', () => {
        expect(items.map(item => item.node.id)).toEqual([
            'func:a.js#Crawler.run',
            'data:a.js#Crawler.retries',
            'func:a.js#hidden',
            'data:a.js#TABLE',
        ]);
        expect([...countByType(items).entries()].sort()).toEqual([
            ['data structure', 2],
            ['interface', 2],
        ]);
    });
});
