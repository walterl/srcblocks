import { indexGraph } from '../src/app/public/model.js';
import { buildRenderPlan } from '../src/app/public/viewmodel.js';

const graph = {
    nodes: [
        { id: 'module:src', kind: 'module', name: 'src', parent: null, inBase: true },
        { id: 'file:a.js', kind: 'file', name: 'a.js', parent: 'module:src', inBase: true },
        { id: 'file:b.js', kind: 'file', name: 'b.js', parent: 'module:src', inBase: true },
        { id: 'fn:a', kind: 'function', name: 'a', parent: 'file:a.js', inBase: true },
        { id: 'fn:a2', kind: 'function', name: 'a2', parent: 'file:a.js', inBase: true },
        { id: 'fn:b', kind: 'function', name: 'b', parent: 'file:b.js', inBase: true },
    ],
    edges: [
        { id: 'a->b', source: 'fn:a', target: 'fn:b', callCount: 1, inBase: true },
        { id: 'a->a2', source: 'fn:a', target: 'fn:a2', callCount: 1, inBase: true },
        { id: 'b->b', source: 'fn:b', target: 'fn:b', callCount: 1, inBase: true },
    ],
};

const index = indexGraph(graph);
const view = {
    present: new Set(graph.nodes.map(node => node.id)),
    status: new Map(),
    edgePresent: new Set(graph.edges.map(edge => edge.id)),
    edgeStatus: new Map(),
};
const planFor = (...expanded) => buildRenderPlan(index, view, new Set(expanded));
const drawnIds = plan => plan.drawn.map(item => item.node.id);
const edgePairs = plan => plan.edges.map(edge => `${edge.source} -> ${edge.target}`);

describe('buildRenderPlan', () => {
    it('draws an edge from a collapsed file to a function in an expanded one', () => {
        const plan = planFor('module:src', 'file:b.js');

        expect(drawnIds(plan)).toEqual(['module:src', 'file:a.js', 'file:b.js', 'fn:b']);
        expect(edgePairs(plan)).toContain('file:a.js -> fn:b');
    });

    it('falls back to file level once the other side is collapsed too', () => {
        expect(edgePairs(planFor('module:src'))).toContain('file:a.js -> file:b.js');
    });

    it('hides calls that happen inside a collapsed container', () => {
        expect(edgePairs(planFor('module:src'))).not.toContain('file:a.js -> file:a.js');
    });

    it('keeps a recursive call visible on the function itself', () => {
        const plan = planFor('module:src', 'file:b.js');
        expect(plan.edges.find(edge => edge.source === 'fn:b')).toMatchObject({ target: 'fn:b', recursive: true });
    });

    it('collapses a whole subtree into its outermost closed container', () => {
        const plan = planFor();
        expect(drawnIds(plan)).toEqual(['module:src']);
        expect(plan.edges).toEqual([]);
    });

    it('sums the calls an aggregated edge stands for', () => {
        const plan = planFor('module:src');
        const aggregated = plan.edges.find(edge => edge.target === 'file:b.js');
        expect(aggregated.count).toBe(1);
        expect(aggregated.members).toEqual(['a->b']);
    });
});
