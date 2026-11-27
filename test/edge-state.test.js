import { deriveViewState, indexGraph } from '../src/app/public/model.js';

/*
 * A branch where an earlier commit (c1) rewrote a function to call new things,
 * and a later one (c2) added another call. Selecting only c2 still shows c1's
 * work, because a revision's source carries every commit before it.
 */
const fn = (id, extra) => ({ id, kind: 'function', name: id, parent: 'file:a.js', ...extra });

/* What a revision called, in the shape the analyser records it. */
const calls = (...targets) => targets.map(target => ({ target, carries: null }));

const index = indexGraph({
    nodes: [
        { id: 'file:a.js', kind: 'file', name: 'a.js', file: 'a.js', parent: null, inBase: true },
        fn('caller', {
            inBase: true,
            base: { code: 'old', hash: 'a', calls: calls('oldCallee', 'keeper') },
            versions: [
                { sha: 'c1', code: 'mid', hash: 'b', calls: calls('newCallee', 'keeper') },
                { sha: 'c2', code: 'new', hash: 'c', calls: calls('newCallee', 'lateCallee', 'keeper') },
            ],
        }),
        fn('keeper', { inBase: true, base: { code: 'k', hash: 'k', calls: [] }, versions: [] }),
        fn('oldCallee', { inBase: true, base: { code: 'o', hash: 'o', calls: [] }, versions: [] }),
        fn('newCallee', { inBase: false, base: null, versions: [{ sha: 'c1', code: 'n', hash: 'n', calls: [] }] }),
        fn('lateCallee', { inBase: false, base: null, versions: [{ sha: 'c2', code: 'l', hash: 'l', calls: [] }] }),
    ],
    edges: [
        { id: 'caller->oldCallee', source: 'caller', target: 'oldCallee', inBase: true },
        { id: 'caller->keeper', source: 'caller', target: 'keeper', inBase: true },
        { id: 'caller->newCallee', source: 'caller', target: 'newCallee', inBase: false },
        { id: 'caller->lateCallee', source: 'caller', target: 'lateCallee', inBase: false },
    ],
});

const analysis = {
    commits: [{ sha: 'c1' }, { sha: 'c2' }],
    perCommit: {
        // c2 touches the function but none of the calls c1 changed - which is
        // what used to leave those calls uncoloured.
        c1: {
            nodes: { caller: 'changed', newCallee: 'added' },
            edges: { 'caller->newCallee': 'added', 'caller->oldCallee': 'removed' },
        },
        c2: { nodes: { caller: 'changed', lateCallee: 'added' }, edges: { 'caller->lateCallee': 'added' } },
    },
};

const stateFor = (...shas) => deriveViewState(index, analysis, new Set(shas));

describe('call state under a commit selection', () => {
    it('compares the calls of the shown revision with the base revision', () => {
        const state = stateFor('c2');

        expect(state.edgeStatus.get('caller->newCallee')).toBe('added');
        expect(state.edgeStatus.get('caller->lateCallee')).toBe('added');
        expect(state.edgeStatus.get('caller->oldCallee')).toBe('removed');
        expect(state.edgeStatus.has('caller->keeper')).toBe(false);
    });

    it('keeps a call the shown revision no longer makes, so it can be shown as gone', () => {
        expect(stateFor('c2').edgePresent.has('caller->oldCallee')).toBe(true);
    });

    it('brings in a callee that only an unselected commit added', () => {
        const state = stateFor('c2');
        expect(state.present.has('newCallee')).toBe(true);
        expect(state.present.has('file:a.js')).toBe(true);
    });

    it('shows the base revision when nothing is selected', () => {
        const state = stateFor();
        expect(state.edgePresent.has('caller->oldCallee')).toBe(true);
        expect(state.edgePresent.has('caller->newCallee')).toBe(false);
        expect(state.edgeStatus.size).toBe(0);
    });

    it('takes the calls of a removed function with it', () => {
        const removal = {
            commits: [{ sha: 'c1' }],
            perCommit: { c1: { nodes: { caller: 'removed' }, edges: {} } },
        };
        const state = deriveViewState(index, removal, new Set(['c1']));
        expect(state.edgeStatus.get('caller->keeper')).toBe('removed');
    });

    it('falls back to what the commits reported when a graph has no call sets', () => {
        const plain = indexGraph({
            nodes: [
                { id: 'file:a.js', kind: 'file', name: 'a.js', parent: null, inBase: true },
                { id: 'a', kind: 'function', name: 'a', parent: 'file:a.js', inBase: true },
                { id: 'b', kind: 'function', name: 'b', parent: 'file:a.js', inBase: true },
            ],
            edges: [{ id: 'a->b', source: 'a', target: 'b', inBase: true }],
        });
        const state = deriveViewState(plain, null, new Set());
        expect(state.edgePresent.has('a->b')).toBe(true);
    });
});
