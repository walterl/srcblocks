import {
    baseSourceOf,
    describeContainer,
    describeCounts,
    deriveViewState,
    groupCallsByContainer,
    incomingCalls,
    indexGraph,
    isMethod,
    outgoingCalls,
    sourceOf,
} from '../src/app/public/model.js';

const node = (id, extra = {}) => ({ id, kind: 'function', name: id, parent: 'file:a.js', inBase: true, ...extra });

const graph = {
    nodes: [
        { id: 'module:src', kind: 'module', name: 'src', parent: null, inBase: true },
        { id: 'file:a.js', kind: 'file', name: 'a.js', parent: 'module:src', inBase: true },
        node('untouched'),
        node('edited'),
        node('deleted'),
        node('created', { inBase: false }),
        node('shortLived', { inBase: false }),
    ],
    edges: [
        { id: 'untouched->edited', source: 'untouched', target: 'edited', inBase: true },
        { id: 'edited->created', source: 'edited', target: 'created', inBase: false },
    ],
};

const analysis = {
    commits: [{ sha: 'c1' }, { sha: 'c2' }],
    perCommit: {
        c1: {
            nodes: { created: 'added', shortLived: 'added', edited: 'changed' },
            edges: { 'edited->created': 'added' },
        },
        c2: {
            nodes: { deleted: 'removed', shortLived: 'removed' },
            edges: { 'untouched->edited': 'removed' },
        },
    },
};

const index = indexGraph(graph);
const stateFor = (...shas) => deriveViewState(index, analysis, new Set(shas));

describe('deriveViewState', () => {
    it('shows the base graph when no commit is selected', () => {
        const state = stateFor();
        expect([...state.present].sort()).toEqual(['edited', 'file:a.js', 'module:src', 'untouched', 'deleted'].sort());
        expect(state.status.size).toBe(0);
    });

    it('colours what the selected commits did', () => {
        const state = stateFor('c1', 'c2');
        expect(state.status.get('created')).toBe('added');
        expect(state.status.get('edited')).toBe('changed');
        expect(state.status.get('deleted')).toBe('removed');
        expect(state.present.has('deleted')).toBe(true);
    });

    it('hides a function that a later selected commit removed again', () => {
        expect(stateFor('c1').present.has('shortLived')).toBe(true);
        expect(stateFor('c1', 'c2').present.has('shortLived')).toBe(false);
    });

    it('keeps a function the selection never had off the canvas, calls and all', () => {
        const withCall = indexGraph({
            nodes: [
                { id: 'file:a.js', kind: 'file', name: 'a.js', parent: null, inBase: true },
                node('untouched', { parent: 'file:a.js' }),
                node('shortLived', {
                    parent: 'file:a.js',
                    inBase: false,
                    versions: [{ sha: 'c1', code: 'gone now', hash: 'bbb', calls: [{ target: 'untouched' }] }],
                }),
            ],
            edges: [{ id: 'shortLived->untouched', source: 'shortLived', target: 'untouched', inBase: false }],
        });
        const churn = {
            commits: [{ sha: 'c1' }, { sha: 'c2' }],
            perCommit: {
                c1: { nodes: { shortLived: 'added' }, edges: { 'shortLived->untouched': 'added' } },
                c2: { nodes: { shortLived: 'removed' }, edges: { 'shortLived->untouched': 'removed' } },
            },
        };

        const state = deriveViewState(withCall, churn, new Set(['c1', 'c2']));
        expect(state.present.has('shortLived')).toBe(false);
        expect(state.edgePresent.has('shortLived->untouched')).toBe(false);
    });

    it('hides what only unselected commits introduced', () => {
        const state = stateFor('c2');
        expect(state.present.has('created')).toBe(false);
        expect(state.status.has('edited')).toBe(false);
    });

    it('does not mark a function changed when the selection leaves it as it was', () => {
        const reverted = indexGraph({
            nodes: [
                { id: 'file:a.js', kind: 'file', name: 'a.js', parent: null, inBase: true },
                {
                    id: 'churned',
                    kind: 'function',
                    name: 'churned',
                    parent: 'file:a.js',
                    inBase: true,
                    base: { code: 'original', hash: 'aaa' },
                    versions: [
                        { sha: 'c1', code: 'edited', hash: 'bbb' },
                        { sha: 'c2', code: 'original', hash: 'aaa' },
                    ],
                },
            ],
            edges: [],
        });
        const churn = {
            commits: [{ sha: 'c1' }, { sha: 'c2' }],
            perCommit: {
                c1: { nodes: { churned: 'changed' }, edges: {} },
                c2: { nodes: { churned: 'changed' }, edges: {} },
            },
        };

        expect(deriveViewState(reverted, churn, new Set(['c1'])).status.get('churned')).toBe('changed');
        expect(deriveViewState(reverted, churn, new Set(['c1', 'c2'])).status.has('churned')).toBe(false);
        expect(deriveViewState(reverted, churn, new Set(['c1', 'c2'])).present.has('churned')).toBe(true);
    });

    it('marks containers of changed functions as changed', () => {
        const state = stateFor('c1');
        expect(state.status.get('file:a.js')).toBe('changed');
        expect(state.status.get('module:src')).toBe('changed');
    });

    it('only keeps an edge while both of its ends are shown', () => {
        expect(stateFor('c1').edgeStatus.get('edited->created')).toBe('added');
        expect(stateFor('c1', 'c2').edgeStatus.get('untouched->edited')).toBe('removed');
        expect(stateFor('c2').edgePresent.has('edited->created')).toBe(false);
    });
});

describe('deriveViewState edge statuses', () => {
    it('leaves a call that was removed and added back uncoloured', () => {
        const churn = {
            commits: [{ sha: 'c1' }, { sha: 'c2' }],
            perCommit: {
                c1: { nodes: {}, edges: { 'untouched->edited': 'removed' } },
                c2: { nodes: {}, edges: { 'untouched->edited': 'added' } },
            },
        };
        const state = deriveViewState(index, churn, new Set(['c1', 'c2']));
        expect(state.edgePresent.has('untouched->edited')).toBe(true);
        expect(state.edgeStatus.has('untouched->edited')).toBe(false);
    });
});

describe('sourceOf', () => {
    const versioned = {
        id: 'fn',
        kind: 'function',
        base: { code: 'base', doc: null },
        versions: [
            { sha: 'c1', code: 'after c1', doc: null },
            { sha: 'c3', code: 'after c3', doc: null },
        ],
    };

    it('shows what the newest selected commit made of the function', () => {
        expect(sourceOf(versioned, new Set(['c1', 'c3'])).code).toBe('after c3');
        expect(sourceOf(versioned, new Set(['c1'])).code).toBe('after c1');
    });

    it('falls back to the base revision when no selected commit touched it', () => {
        expect(sourceOf(versioned, new Set(['other'])).code).toBe('base');
        expect(sourceOf(versioned, new Set()).code).toBe('base');
    });

    it('reads a single-revision node directly, line numbers and all', () => {
        expect(sourceOf({ code: 'plain', doc: '/** d */', line: 42 }, new Set())).toMatchObject({
            code: 'plain',
            line: 42,
        });
    });

    it('reports the base source only when the function existed before the branch', () => {
        expect(baseSourceOf(versioned).code).toBe('base');
        expect(baseSourceOf({ base: null, versions: [] })).toBe(null);
    });
});

describe('indexGraph ordering', () => {
    it('orders what a file contains the way it is written', () => {
        const file = {
            nodes: [
                { id: 'file:a.js', kind: 'file', name: 'a.js', parent: null, line: 1 },
                { id: 'second', kind: 'function', name: 'second', parent: 'file:a.js', line: 40 },
                { id: 'first', kind: 'function', name: 'first', parent: 'file:a.js', line: 10 },
                { id: 'middle', kind: 'group', name: 'Middle', parent: 'file:a.js', line: 20 },
            ],
            edges: [],
        };
        const ordered = indexGraph(file).children.get('file:a.js');
        expect(ordered.map(node => node.id)).toEqual(['first', 'middle', 'second']);
    });
});

describe('outgoingCalls', () => {
    const callGraph = indexGraph({
        nodes: [
            { id: 'file:a.js', kind: 'file', name: 'a.js', parent: null, inBase: true },
            {
                id: 'caller',
                kind: 'function',
                name: 'caller',
                parent: 'file:a.js',
                file: 'a.js',
                line: 5,
                inBase: true,
            },
            { id: 'early', kind: 'function', name: 'early', parent: 'file:a.js', file: 'a.js', line: 1, inBase: true },
            { id: 'late', kind: 'function', name: 'late', parent: 'file:a.js', file: 'z.js', line: 9, inBase: true },
        ],
        edges: [
            // 'late' is written earlier in caller's body than 'early'.
            { id: 'caller->late', source: 'caller', target: 'late', callCount: 2, line: 6, inBase: true },
            { id: 'caller->early', source: 'caller', target: 'early', callCount: 1, line: 8, inBase: true },
            { id: 'early->caller', source: 'early', target: 'caller', callCount: 1, line: 2, inBase: true },
        ],
    });
    const allVisible = deriveViewState(callGraph, null, new Set());

    it('lists what the function calls in the order the calls are written', () => {
        expect(outgoingCalls(callGraph, allVisible, 'caller').map(call => call.node.id)).toEqual(['late', 'early']);
    });

    it('falls back to where the callee is written when call sites are unknown', () => {
        const noSites = indexGraph({
            nodes: [...callGraph.nodes.values()],
            edges: [...callGraph.edges].map(({ line, ...edge }) => edge),
        });
        expect(outgoingCalls(noSites, allVisible, 'caller').map(call => call.node.id)).toEqual(['early', 'late']);
    });

    it('reports how many call sites an entry stands for', () => {
        const [late] = outgoingCalls(callGraph, allVisible, 'caller');
        expect(late).toMatchObject({ callCount: 2, status: null, recursive: false });
    });

    it('reports what the branch did to the call and to the callee', () => {
        const diffed = {
            ...allVisible,
            status: new Map([
                ['early', 'added'],
                ['late', 'changed'],
            ]),
            edgeStatus: new Map([['caller->early', 'added']]),
        };
        const [late, early] = outgoingCalls(callGraph, diffed, 'caller');

        expect(early).toMatchObject({ status: 'added', nodeStatus: 'added' });
        expect(late).toMatchObject({ status: null, nodeStatus: 'changed' });
    });

    it('lists what calls a function', () => {
        expect(incomingCalls(callGraph, allVisible, 'caller').map(call => call.node.id)).toEqual(['early']);
        expect(incomingCalls(callGraph, allVisible, 'late')).toEqual([
            expect.objectContaining({ node: expect.objectContaining({ id: 'caller' }), callCount: 2 }),
        ]);
    });

    it('leaves out calls the commit selection does not show', () => {
        const hidden = { ...allVisible, edgePresent: new Set(['caller->early']) };
        expect(outgoingCalls(callGraph, hidden, 'caller').map(call => call.node.id)).toEqual(['early']);
    });
});

describe('the calls of a container', () => {
    const method = (id, line) => ({
        id,
        kind: 'function',
        name: id,
        parent: 'group:a.js#Thing',
        file: 'a.js',
        line,
        inBase: true,
    });
    const classGraph = indexGraph({
        nodes: [
            { id: 'file:a.js', kind: 'file', name: 'a.js', parent: null, file: 'a.js', inBase: true },
            {
                id: 'group:a.js#Thing',
                kind: 'group',
                groupKind: 'class',
                name: 'Thing',
                parent: 'file:a.js',
                file: 'a.js',
                line: 1,
                inBase: true,
            },
            method('first', 2),
            method('second', 6),
            {
                id: 'helper',
                kind: 'function',
                name: 'helper',
                parent: 'file:b.js',
                file: 'b.js',
                line: 3,
                inBase: true,
            },
            { id: 'other', kind: 'function', name: 'other', parent: 'file:b.js', file: 'b.js', line: 9, inBase: true },
            {
                id: 'outside',
                kind: 'function',
                name: 'outside',
                parent: 'file:b.js',
                file: 'b.js',
                line: 1,
                inBase: true,
            },
        ],
        edges: [
            { id: 'first->helper', source: 'first', target: 'helper', callCount: 1, line: 3, inBase: true },
            { id: 'second->helper', source: 'second', target: 'helper', callCount: 2, line: 7, inBase: true },
            { id: 'second->other', source: 'second', target: 'other', callCount: 1, line: 8, inBase: true },
            { id: 'outside->second', source: 'outside', target: 'second', callCount: 1, line: 2, inBase: true },
        ],
    });
    const view = deriveViewState(classGraph, null, new Set());

    it('lists what everything inside it calls, in the order the callees are written', () => {
        expect(outgoingCalls(classGraph, view, 'group:a.js#Thing').map(call => call.node.id)).toEqual([
            'helper',
            'other',
        ]);
    });

    it('says once what two of its members call, counting every site', () => {
        const [helper] = outgoingCalls(classGraph, view, 'group:a.js#Thing');
        expect(helper).toMatchObject({ node: expect.objectContaining({ id: 'helper' }), callCount: 3 });
    });

    it('colours a merged entry only where every site agrees', () => {
        const mixed = { ...view, edgeStatus: new Map([['first->helper', 'added']]) };
        const [helper, other] = outgoingCalls(classGraph, mixed, 'group:a.js#Thing');
        expect(helper.status).toBeNull();

        const agreed = { ...view, edgeStatus: new Map([['second->other', 'added']]) };
        expect(outgoingCalls(classGraph, agreed, 'group:a.js#Thing')[1].status).toBe('added');
        expect(other.status).toBeNull();
    });

    it('lists what reaches into it', () => {
        expect(incomingCalls(classGraph, view, 'group:a.js#Thing').map(call => call.node.id)).toEqual(['outside']);
    });

    it('answers for a whole file the same way', () => {
        expect(outgoingCalls(classGraph, view, 'file:a.js').map(call => call.node.id)).toEqual(['helper', 'other']);
    });
});

describe('groupCallsByContainer', () => {
    const index = indexGraph({
        nodes: [
            { id: 'module:src', kind: 'module', name: 'src', path: 'src', parent: null, inBase: true },
            { id: 'module:src/lib', kind: 'module', name: 'lib', path: 'src/lib', parent: 'module:src', inBase: true },
            {
                id: 'file:src/lib/a.js',
                kind: 'file',
                name: 'a.js',
                parent: 'module:src/lib',
                file: 'src/lib/a.js',
                inBase: true,
            },
            {
                id: 'group:src/lib/a.js#Thing',
                kind: 'group',
                groupKind: 'class',
                name: 'Thing',
                parent: 'file:src/lib/a.js',
                file: 'src/lib/a.js',
                line: 1,
                inBase: true,
            },
            {
                id: 'method',
                kind: 'function',
                name: 'method',
                parent: 'group:src/lib/a.js#Thing',
                file: 'src/lib/a.js',
                line: 2,
                inBase: true,
            },
            {
                id: 'loose',
                kind: 'function',
                name: 'loose',
                parent: 'file:src/lib/a.js',
                file: 'src/lib/a.js',
                line: 9,
                inBase: true,
            },
            { id: 'orphan', kind: 'function', name: 'orphan', parent: null, file: 'x.js', line: 1, inBase: true },
        ],
        edges: [],
    });
    const callsFor = ids => ids.map(id => ({ node: index.nodes.get(id) }));

    it('nests the calls the way the graph nests what holds them', () => {
        const { branches } = groupCallsByContainer(index, callsFor(['method', 'loose']));

        // The modules on the way to the file hold nothing else, so they read as
        // the one path they are.
        expect(branches.map(branch => [branch.id, branch.name])).toEqual([['file:src/lib/a.js', 'src/lib/a.js']]);
        const [file] = branches;
        expect(file.children.map(branch => [branch.id, branch.name])).toEqual([['group:src/lib/a.js#Thing', 'Thing']]);
        expect(file.children[0].calls.map(call => call.node.id)).toEqual(['method']);
        // A function the file declares itself hangs off the file.
        expect(file.calls.map(call => call.node.id)).toEqual(['loose']);
    });

    it('keeps a module that holds more than a module of its own', () => {
        const wider = indexGraph({
            nodes: [
                ...[...index.nodes.values()],
                {
                    id: 'file:src/top.js',
                    kind: 'file',
                    name: 'top.js',
                    parent: 'module:src',
                    file: 'src/top.js',
                    inBase: true,
                },
                {
                    id: 'alone',
                    kind: 'function',
                    name: 'alone',
                    parent: 'file:src/top.js',
                    file: 'src/top.js',
                    line: 1,
                    inBase: true,
                },
            ],
            edges: [],
        });
        const { branches } = groupCallsByContainer(wider, [
            { node: wider.nodes.get('method') },
            { node: wider.nodes.get('alone') },
        ]);

        expect(branches.map(branch => branch.name)).toEqual(['src']);
        expect(branches[0].children.map(branch => branch.name)).toEqual(['lib/a.js', 'top.js']);
    });

    it('counts everything beneath a branch, however deep', () => {
        const { branches } = groupCallsByContainer(index, callsFor(['method', 'loose']));
        expect(branches[0].count).toBe(2);
        expect(branches[0].children[0].count).toBe(1);
    });

    it('leaves a call with nothing above it beside the tree', () => {
        const { branches, calls } = groupCallsByContainer(index, callsFor(['orphan']));
        expect(branches).toEqual([]);
        expect(calls.map(call => call.node.id)).toEqual(['orphan']);
    });
});

describe('describeContainer', () => {
    const tree = indexGraph({
        nodes: [
            { id: 'module:src', kind: 'module', name: 'src', path: 'src', parent: null, inBase: true },
            { id: 'file:src/a.js', kind: 'file', name: 'a.js', file: 'src/a.js', parent: 'module:src', inBase: true },
            {
                id: 'group:src/a.js#A',
                kind: 'group',
                groupKind: 'class',
                name: 'A',
                file: 'src/a.js',
                parent: 'file:src/a.js',
                inBase: true,
            },
            {
                id: 'fn:method',
                kind: 'function',
                name: 'method',
                file: 'src/a.js',
                parent: 'group:src/a.js#A',
                inBase: true,
            },
            {
                id: 'fn:loose',
                kind: 'function',
                name: 'loose',
                file: 'src/a.js',
                parent: 'file:src/a.js',
                inBase: true,
            },
            { id: 'fn:gone', kind: 'function', name: 'gone', file: 'src/a.js', parent: 'file:src/a.js', inBase: true },
        ],
        edges: [],
    });
    const view = {
        present: new Set(tree.nodes.keys()),
        status: new Map([
            ['fn:method', 'changed'],
            ['fn:gone', 'removed'],
            ['file:src/a.js', 'changed'],
        ]),
        edgePresent: new Set(),
        edgeStatus: new Map(),
    };

    it('counts everything inside, at any depth', () => {
        expect(describeContainer(tree, view, 'module:src').counts).toEqual({ file: 1, class: 1, function: 3 });
    });

    it('counts what the branch did to the functions inside', () => {
        expect(describeContainer(tree, view, 'file:src/a.js').changes).toEqual({ added: 0, changed: 1, removed: 1 });
    });

    it('reports where a container lives', () => {
        expect(describeContainer(tree, view, 'module:src').path).toBe('src');
        expect(describeContainer(tree, view, 'file:src/a.js')).toMatchObject({ path: 'src/a.js', kind: 'file' });
        expect(describeContainer(tree, view, 'group:src/a.js#A')).toMatchObject({
            path: 'src/a.js › A',
            kind: 'class',
        });
    });

    it('leaves functions alone', () => {
        expect(describeContainer(tree, view, 'fn:loose')).toBe(null);
    });

    it('counts only what the selection shows', () => {
        const partial = { ...view, present: new Set(['module:src', 'file:src/a.js', 'fn:loose']) };
        expect(describeContainer(tree, partial, 'file:src/a.js').counts.function).toBe(1);
    });

    it('phrases counts, skipping what is not there', () => {
        expect(describeCounts({ file: 1, function: 12 })).toBe('1 file · 12 functions');
    });

    it('counts constants and types by what they are', () => {
        const withData = indexGraph({
            nodes: [
                { id: 'file:a.js', kind: 'file', name: 'a.js', file: 'a.js', parent: null, inBase: true },
                {
                    id: 'data:a.js#RATE',
                    kind: 'data',
                    dataKind: 'constant',
                    name: 'RATE',
                    file: 'a.js',
                    parent: 'file:a.js',
                    inBase: true,
                },
                {
                    id: 'data:a.js#Shape',
                    kind: 'data',
                    dataKind: 'type',
                    name: 'Shape',
                    file: 'a.js',
                    parent: 'file:a.js',
                    inBase: true,
                },
            ],
            edges: [],
        });
        const all = {
            present: new Set(withData.nodes.keys()),
            status: new Map(),
            edgePresent: new Set(),
            edgeStatus: new Map(),
        };
        expect(describeCounts(describeContainer(withData, all, 'file:a.js').counts)).toBe('1 type · 1 constant');
    });
});

describe('isMethod', () => {
    const index = indexGraph({
        nodes: [
            { id: 'file:a.js', kind: 'file', name: 'a.js', parent: null, inBase: true },
            {
                id: 'group:a.js#Crawler',
                kind: 'group',
                groupKind: 'class',
                name: 'Crawler',
                parent: 'file:a.js',
                inBase: true,
            },
            {
                id: 'group:a.js#Suite',
                kind: 'group',
                groupKind: 'suite',
                name: 'Suite',
                parent: 'file:a.js',
                inBase: true,
            },
            { id: 'method', kind: 'function', name: 'run', parent: 'group:a.js#Crawler', inBase: true },
            { id: 'plain', kind: 'function', name: 'helper', parent: 'file:a.js', inBase: true },
            {
                id: 'case',
                kind: 'function',
                role: 'test',
                name: 'does a thing',
                parent: 'group:a.js#Suite',
                inBase: true,
            },
        ],
        edges: [],
    });
    const nodeOf = id => index.nodes.get(id);

    it('knows a class member from a bare function', () => {
        expect(isMethod(index, nodeOf('method'))).toBe(true);
        expect(isMethod(index, nodeOf('plain'))).toBe(false);
    });

    it('does not count a test as a method of its suite', () => {
        expect(isMethod(index, nodeOf('case'))).toBe(false);
    });
});
