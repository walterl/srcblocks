import {
    buildFileTree,
    createMatcher,
    deriveViewState,
    indexGraph,
    outgoingCalls,
    restrictToChanges,
    searchNodes,
} from '../src/app/public/model.js';

/*
 * Two files under one module. The branch changed something in each, and a
 * function in b.js calls one in a.js.
 */
const fn = (id, file, extra) => ({ id, kind: 'function', name: id, file, line: 10, parent: `file:${file}`, ...extra });

const index = indexGraph({
    nodes: [
        { id: 'module:src', kind: 'module', name: 'src', path: 'src', parent: null, inBase: true },
        { id: 'file:a.js', kind: 'file', name: 'a.js', file: 'a.js', parent: 'module:src', inBase: true },
        { id: 'file:b.js', kind: 'file', name: 'b.js', file: 'b.js', parent: 'module:src', inBase: true },
        fn('one', 'a.js', {
            inBase: true,
            base: { code: 'old', hash: 'a', calls: [] },
            versions: [{ sha: 'c1', code: 'new', hash: 'b', calls: [] }],
        }),
        fn('two', 'a.js', { inBase: true, base: { code: 'k', hash: 'k', calls: [] }, versions: [] }),
        fn('three', 'b.js', {
            inBase: true,
            base: { code: 'x', hash: 'x', calls: ['one'] },
            versions: [{ sha: 'c1', code: 'y', hash: 'y', calls: ['one'] }],
        }),
    ],
    edges: [{ id: 'three->one', source: 'three', target: 'one', inBase: true }],
});

const analysis = {
    commits: [{ sha: 'c1' }],
    perCommit: { c1: { nodes: { one: 'changed', three: 'changed' }, edges: {} } },
};

const viewWith = (...hidden) => deriveViewState(index, analysis, new Set(['c1']), new Set(hidden));

describe('hiding a node', () => {
    it('leaves the node itself on the canvas', () => {
        const view = viewWith('file:a.js');
        expect(view.present.has('file:a.js')).toBe(true);
        expect(view.hidden.has('file:a.js')).toBe(true);
        // And so is what holds it: the way back has to be reachable.
        expect(view.present.has('module:src')).toBe(true);
    });

    it('takes everything under it off the canvas', () => {
        const view = viewWith('file:a.js');
        expect(view.present.has('one')).toBe(false);
        expect(view.present.has('two')).toBe(false);
        expect(view.present.has('three')).toBe(true);
    });

    it('drops the calls at either end of it', () => {
        expect(viewWith().edgePresent.has('three->one')).toBe(true);
        expect(viewWith('file:a.js').edgePresent.has('three->one')).toBe(false);
        expect(outgoingCalls(index, viewWith('file:a.js'), 'three')).toEqual([]);
    });

    it('says nothing about what the branch did, so what it holds is not counted', () => {
        const view = viewWith('file:a.js');
        expect(view.status.has('file:a.js')).toBe(false);
        expect(view.status.has('one')).toBe(false);
        // The module is still changed, but by b.js alone.
        expect(view.status.get('module:src')).toBe('changed');
    });

    it('leaves a container untouched when its only change was inside it', () => {
        const view = viewWith('file:a.js', 'file:b.js');
        expect(view.status.has('module:src')).toBe(false);
    });

    it('is left out of the file tree when nothing else in it changed', () => {
        const listed = view =>
            buildFileTree(index, view, { changedOnly: true })[0]?.children.map(child => child.name) || [];
        expect(listed(viewWith())).toEqual(['a.js', 'b.js']);
        expect(listed(viewWith('file:a.js'))).toEqual(['b.js']);
    });

    it('is not found by a search', () => {
        const search = view =>
            searchNodes(index, view, createMatcher('one', false), () => ({ code: '' })).results.map(hit => hit.node.id);
        expect(search(viewWith())).toEqual(['one']);
        expect(search(viewWith('file:a.js'))).toEqual([]);
        // The hidden node itself is no more findable than what it holds.
        expect(search(viewWith('one'))).toEqual([]);
    });

    it('stays on a canvas showing only what the branch touched', () => {
        const view = viewWith('file:a.js');
        expect(restrictToChanges(index, view).present.has('file:a.js')).toBe(true);
    });
});
