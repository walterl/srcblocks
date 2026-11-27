import { collectDiffHunks, diffStats, indexGraph } from '../src/app/public/model.js';

const fn = (id, name, file, line, extra) => ({
    id,
    kind: 'function',
    name,
    file,
    line,
    parent: `file:${file}`,
    ...extra,
});

const graph = {
    nodes: [
        { id: 'file:a.js', kind: 'file', name: 'a.js', file: 'a.js', parent: null, inBase: true },
        { id: 'file:b.js', kind: 'file', name: 'b.js', file: 'b.js', parent: null, inBase: true },
        fn('fn:kept', 'kept', 'a.js', 1, { base: { code: 'kept', line: 1 }, versions: [], inBase: true }),
        fn('fn:changed', 'changed', 'a.js', 10, {
            base: { code: 'const a = 1;\nreturn a;', line: 8 },
            versions: [{ sha: 'c1', code: 'const a = 2;\nreturn a;', line: 10 }],
            inBase: true,
        }),
        fn('fn:added', 'added', 'b.js', 20, {
            base: null,
            versions: [{ sha: 'c1', code: 'function added() {}', line: 20 }],
            inBase: false,
        }),
        fn('fn:removed', 'removed', 'a.js', 40, {
            base: { code: 'function removed() {\n}', line: 40 },
            versions: [],
            inBase: true,
        }),
    ],
    edges: [],
};

const index = indexGraph(graph);
const view = {
    present: new Set(['file:a.js', 'file:b.js', 'fn:kept', 'fn:changed', 'fn:added', 'fn:removed']),
    status: new Map([
        ['fn:changed', 'changed'],
        ['fn:added', 'added'],
        ['fn:removed', 'removed'],
    ]),
    edgePresent: new Set(),
    edgeStatus: new Map(),
};
const sourceOf = node => (node.versions?.length ? node.versions.at(-1) : node.base) || { code: '', line: node.line };
const files = collectDiffHunks(index, view, sourceOf);

describe('collectDiffHunks', () => {
    it('groups hunks by file, in path order', () => {
        expect(files.map(file => file.file)).toEqual(['a.js', 'b.js']);
    });

    it('leaves untouched functions out', () => {
        expect(files.flatMap(file => file.hunks).map(hunk => hunk.node.id)).toEqual([
            'fn:changed',
            'fn:removed',
            'fn:added',
        ]);
    });

    it('diffs a changed function against the base revision', () => {
        const [changed] = files[0].hunks;
        expect(changed.rows.map(row => `${row.type[0]}${row.text}`)).toEqual([
            'rconst a = 1;',
            'aconst a = 2;',
            'creturn a;',
        ]);
        expect(changed).toMatchObject({ added: 1, removed: 1, from: 10 });
    });

    it('shows an added function as all additions, numbered from where it now sits', () => {
        const [added] = files[1].hunks;
        expect(added.rows.every(row => row.type === 'added')).toBe(true);
        expect(added).toMatchObject({ from: 20, numbering: 'added' });
    });

    it('names the revision each hunk was taken from, for blaming its lines', () => {
        expect(files[0].hunks[0].sha).toBe('c1');
        expect(files[1].hunks[0].sha).toBe('c1');
        // A removed function has no revision on the branch to blame.
        expect(files[0].hunks[1].sha).toBe(null);
    });

    it('shows a removed function as all removals, numbered from where it was', () => {
        const removed = files[0].hunks[1];
        expect(removed.rows.every(row => row.type === 'removed')).toBe(true);
        expect(removed).toMatchObject({ from: 40, numbering: 'removed' });
    });

    it('has nothing to show when no commit is selected', () => {
        const quiet = { ...view, status: new Map() };
        expect(collectDiffHunks(index, quiet, sourceOf)).toEqual([]);
    });
});

describe('collectDiffHunks with documentation changes', () => {
    const docOnly = indexGraph({
        nodes: [
            { id: 'file:a.js', kind: 'file', name: 'a.js', file: 'a.js', parent: null, inBase: true },
            {
                id: 'fn:documented',
                kind: 'function',
                name: 'documented',
                file: 'a.js',
                line: 5,
                parent: 'file:a.js',
                base: { code: 'const a = 1;', doc: '/** Old. */', line: 5 },
                versions: [{ sha: 'c1', code: 'const a = 1;', doc: '/** New. */', line: 5 }],
                inBase: true,
            },
            {
                id: 'fn:reformatted',
                kind: 'function',
                name: 'reformatted',
                file: 'a.js',
                line: 20,
                parent: 'file:a.js',
                base: { code: 'same', doc: null, line: 20 },
                versions: [{ sha: 'c1', code: 'same', doc: null, line: 20 }],
                inBase: true,
            },
        ],
        edges: [],
    });
    const view = {
        present: new Set(docOnly.nodes.keys()),
        status: new Map([
            ['fn:documented', 'changed'],
            ['fn:reformatted', 'changed'],
        ]),
        edgePresent: new Set(),
        edgeStatus: new Map(),
    };
    const [file] = collectDiffHunks(docOnly, view, node => node.versions.at(-1));

    it('diffs the documentation when the source is untouched', () => {
        expect(file.hunks).toHaveLength(1);
        expect(file.hunks[0]).toMatchObject({
            node: expect.objectContaining({ id: 'fn:documented' }),
            documentation: true,
            from: null,
        });
        expect(file.hunks[0].rows.map(row => `${row.type[0]}${row.text}`)).toEqual(['r/** Old. */', 'a/** New. */']);
    });

    it('drops a hunk with nothing to show', () => {
        expect(file.hunks.map(hunk => hunk.node.id)).not.toContain('fn:reformatted');
    });
});

describe('diffStats', () => {
    const stats = diffStats(index, view, sourceOf);

    it('counts a changed function as the lines its diff moved', () => {
        expect(stats.get('fn:changed')).toEqual({ added: 1, removed: 1 });
    });

    it('counts an added function as all additions and a removed one as all removals', () => {
        expect(stats.get('fn:added')).toEqual({ added: 1, removed: 0 });
        expect(stats.get('fn:removed')).toEqual({ added: 0, removed: 2 });
    });

    it('leaves untouched functions out', () => {
        expect(stats.has('fn:kept')).toBe(false);
    });

    it('gives a file the total of everything it holds', () => {
        expect(stats.get('file:a.js')).toEqual({ added: 1, removed: 3 });
        expect(stats.get('file:b.js')).toEqual({ added: 1, removed: 0 });
    });
});
