import { diffGraphs, isEmptyDiff } from '#srcblocks/analyze/diff.js';

const graph = (nodes, edges = []) => ({ nodes, edges });
const fn = (id, hash) => ({ id, kind: 'function', name: id, hash });
const edge = id => ({ id, kind: 'call' });

describe('diffGraphs', () => {
    it('reports added, removed and changed functions', () => {
        const before = graph([fn('a', '1'), fn('b', '1')]);
        const after = graph([fn('a', '1'), fn('b', '2'), fn('c', '1')]);

        expect(diffGraphs(before, after).nodes).toEqual({ b: 'changed', c: 'added' });
        expect(diffGraphs(after, before).nodes).toEqual({ b: 'changed', c: 'removed' });
    });

    it('does not call a container changed on its own', () => {
        const before = graph([{ id: 'file:a.js', kind: 'file', name: 'a.js' }]);
        const after = graph([{ id: 'file:a.js', kind: 'file', name: 'a.js' }]);

        expect(isEmptyDiff(diffGraphs(before, after))).toBe(true);
    });

    it('reports added and removed calls', () => {
        const before = graph([fn('a', '1')], [edge('a->b')]);
        const after = graph([fn('a', '1')], [edge('a->c')]);

        expect(diffGraphs(before, after).edges).toEqual({ 'a->c': 'added', 'a->b': 'removed' });
    });
});
