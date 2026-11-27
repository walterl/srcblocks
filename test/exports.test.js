import { deriveViewState, exportsOnlyAt, exportState, indexGraph, restrictToExports } from '../src/app/public/model.js';

// A function as a branch analysis records it: the base revision, and what
// commit `c1` made of it.
const fn = (base, c1, extra = {}) => ({
    id: 'f',
    kind: 'function',
    name: 'f',
    base: base === undefined ? null : { code: 'x', exported: base },
    versions: c1 === undefined ? [] : [{ sha: 'c1', code: 'y', exported: c1 }],
    ...extra,
});

const selected = new Set(['c1']);

describe('exportState', () => {
    it('reads an export the selection left alone as plain', () => {
        expect(exportState(fn(true, true), selected)).toBe('exported');
        expect(exportState(fn(true), selected)).toBe('exported');
    });

    it('reads a node that was never exported as not exported', () => {
        expect(exportState(fn(false, false), selected)).toBe(null);
    });

    it('says when the selection exported a node', () => {
        expect(exportState(fn(false, true), selected)).toBe('added');
    });

    it('says when the selection stopped exporting a node', () => {
        expect(exportState(fn(true, false), selected)).toBe('removed');
    });

    it('reads the base when the commit that changed the export is not selected', () => {
        expect(exportState(fn(false, true), new Set())).toBe(null);
        expect(exportState(fn(true, false), new Set())).toBe('exported');
    });

    it('reads a node the branch added exported as newly exported', () => {
        expect(exportState(fn(undefined, true), selected)).toBe('added');
        expect(exportState(fn(undefined, false), selected)).toBe(null);
    });

    it('reads a node the branch removed while exported as no longer exported', () => {
        expect(exportState(fn(true), selected, 'removed')).toBe('removed');
        expect(exportState(fn(false), selected, 'removed')).toBe(null);
        expect(exportState({ id: 'c', kind: 'group', exported: true }, selected, 'removed')).toBe('removed');
    });

    it('reads a node without revisions as it stands, or as new', () => {
        expect(exportState({ id: 'c', kind: 'group', exported: true, inBase: true }, selected)).toBe('exported');
        expect(exportState({ id: 'c', kind: 'group', exported: true }, selected)).toBe('exported');
        expect(exportState({ id: 'c', kind: 'group', exported: true, inBase: false }, selected)).toBe('added');
        expect(exportState({ id: 'c', kind: 'group' }, selected)).toBe(null);
    });
});

describe('restrictToExports', () => {
    const decl = (id, parent, exported, extra = {}) => ({
        id,
        kind: 'function',
        name: id,
        parent,
        inBase: true,
        exported,
        ...extra,
    });
    const index = indexGraph({
        nodes: [
            { id: 'module:src', kind: 'module', name: 'src', parent: null, inBase: true },
            { id: 'file:a.js', kind: 'file', name: 'a.js', parent: 'module:src', inBase: true },
            { id: 'module:lib', kind: 'module', name: 'lib', parent: 'module:src', inBase: true },
            { id: 'file:lib/b.js', kind: 'file', name: 'b.js', parent: 'module:lib', inBase: true },
            { id: 'file:lib/c.js', kind: 'file', name: 'c.js', parent: 'module:lib', inBase: true },
            decl('pub', 'file:a.js', true),
            decl('internal', 'file:a.js', false),
            { id: 'Widget', kind: 'group', name: 'Widget', parent: 'file:a.js', inBase: true, exported: true },
            decl('Widget.draw', 'Widget', false),
            { id: 'Hidden', kind: 'group', name: 'Hidden', parent: 'file:a.js', inBase: true, exported: false },
            decl('Hidden.run', 'Hidden', false),
            decl('libEntry', 'file:lib/b.js', true),
            decl('libInternal', 'file:lib/b.js', false),
            decl('nothingExported', 'file:lib/c.js', false),
            // Exported in the base, and no longer by the selected commit.
            decl('unexported', 'file:a.js', false, {
                base: { code: 'x', exported: true },
                versions: [{ sha: 'c1', code: 'y', exported: false }],
            }),
        ],
        edges: [
            { id: 'pub->internal', source: 'pub', target: 'internal', inBase: true },
            { id: 'pub->libEntry', source: 'pub', target: 'libEntry', inBase: true },
        ],
    });
    const selected = new Set(['c1']);
    const full = deriveViewState(index, null, selected);
    const settings = (everywhere, overrides = {}) => ({ everywhere, overrides: new Map(Object.entries(overrides)) });
    const kept = (given, view = full) => [...restrictToExports(index, view, given, selected).present].sort();
    const only = id => settings(false, { [id]: true });

    it('keeps exported declarations, what they hold, and the files and modules holding them', () => {
        const everything = [
            'Widget',
            'Widget.draw',
            'file:a.js',
            'file:lib/b.js',
            'libEntry',
            'module:lib',
            'module:src',
            'pub',
            'unexported',
        ];
        expect(kept(settings(true))).toEqual(everything.sort());
        expect(kept(only('module:src'))).toEqual(everything.sort());
    });

    it('keeps a declaration the selection stopped exporting', () => {
        expect(kept(only('file:a.js'))).toContain('unexported');
    });

    it('filters only the containers set to show only exports', () => {
        const present = kept(only('file:lib/b.js'));
        expect(present).not.toContain('libInternal');
        expect(present).toContain('internal');
        expect(present).toContain('nothingExported');
    });

    it('keeps a container set to show only exports that holds none, so it can be switched back', () => {
        expect(kept(only('file:lib/c.js'))).toContain('file:lib/c.js');
        expect(kept(only('file:lib/c.js'))).not.toContain('nothingExported');
    });

    it('lets a container be opened back up inside one that shows only exports', () => {
        const present = kept(settings(true, { 'module:lib': false }));
        expect(present).not.toContain('internal');
        expect(present).toContain('libInternal');
        expect(present).toContain('nothingExported');
    });

    it('lets the nearest container set decide', () => {
        const present = kept(settings(false, { 'module:src': true, 'module:lib': false, 'file:lib/b.js': true }));
        expect(present).not.toContain('internal');
        expect(present).not.toContain('libInternal');
        expect(present).toContain('nothingExported');
    });

    it('keeps a hidden file it would otherwise drop as empty', () => {
        const hidden = deriveViewState(index, null, selected, new Set(['file:lib/c.js']));
        expect(kept(settings(true), hidden)).toContain('file:lib/c.js');
    });

    it('keeps calls only while both ends survive', () => {
        expect([...restrictToExports(index, full, settings(true), selected).edgePresent]).toEqual(['pub->libEntry']);
    });

    it('reads a container as the nearest one set says, or as the whole canvas is', () => {
        const given = settings(true, { 'module:lib': false, 'file:lib/c.js': true });
        expect(exportsOnlyAt(index, 'file:a.js', given)).toBe(true);
        expect(exportsOnlyAt(index, 'file:lib/b.js', given)).toBe(false);
        expect(exportsOnlyAt(index, 'file:lib/c.js', given)).toBe(true);
        expect(exportsOnlyAt(index, 'file:a.js', settings(false))).toBe(false);
    });
});
