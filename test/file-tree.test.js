import { buildFileTree, countFiles, indexGraph } from '../src/app/public/model.js';

const index = indexGraph({
    nodes: [
        { id: 'module:src', kind: 'module', name: 'src', path: 'src', parent: null, inBase: true },
        { id: 'module:src/lib', kind: 'module', name: 'lib', path: 'src/lib', parent: 'module:src', inBase: true },
        { id: 'file:src/app.js', kind: 'file', name: 'app.js', file: 'src/app.js', parent: 'module:src', inBase: true },
        {
            id: 'file:src/lib/util.js',
            kind: 'file',
            name: 'util.js',
            file: 'src/lib/util.js',
            parent: 'module:src/lib',
            inBase: true,
        },
        {
            id: 'file:src/lib/quiet.js',
            kind: 'file',
            name: 'quiet.js',
            file: 'src/lib/quiet.js',
            parent: 'module:src/lib',
            inBase: true,
        },
        { id: 'fn', kind: 'function', name: 'fn', parent: 'file:src/lib/util.js', line: 30, inBase: true },
        { id: 'quiet', kind: 'function', name: 'quiet', parent: 'file:src/lib/util.js', line: 10, inBase: true },
        {
            id: 'class:Service',
            kind: 'class',
            name: 'Service',
            file: 'src/lib/util.js',
            parent: 'file:src/lib/util.js',
            line: 20,
            inBase: true,
        },
        {
            id: 'method:run',
            kind: 'function',
            name: 'run',
            file: 'src/lib/util.js',
            parent: 'class:Service',
            line: 21,
            inBase: true,
        },
    ],
    edges: [],
});

const view = {
    present: new Set(index.nodes.keys()),
    status: new Map([
        ['file:src/lib/util.js', 'changed'],
        ['module:src/lib', 'changed'],
        ['module:src', 'changed'],
        ['fn', 'added'],
        ['class:Service', 'changed'],
        ['method:run', 'changed'],
    ]),
    edgePresent: new Set(),
    edgeStatus: new Map(),
};

describe('buildFileTree', () => {
    it('nests files under the directories holding them', () => {
        const [root] = buildFileTree(index, view);
        expect(root).toMatchObject({ name: 'src', kind: 'dir' });
        expect(root.children.map(child => `${child.kind}:${child.name}`)).toEqual(['dir:lib', 'file:app.js']);
        expect(root.children[0].children.map(child => child.name)).toEqual(['quiet.js', 'util.js']);
    });

    it('carries what the branch did to each file', () => {
        const [root] = buildFileTree(index, view);
        const util = root.children[0].children.find(child => child.name === 'util.js');
        expect(util.status).toBe('changed');
        expect(root.children[0].status).toBe('changed');
    });

    it('holds only the touched files when asked', () => {
        const [root] = buildFileTree(index, view, { changedOnly: true });
        expect(countFiles([root])).toBe(1);
        expect(root.children.map(child => child.name)).toEqual(['lib']);
        expect(root.children[0].children.map(child => child.name)).toEqual(['util.js']);
    });

    it('leaves out what the selection does not show', () => {
        const hidden = { ...view, present: new Set(['module:src', 'file:src/app.js']) };
        expect(countFiles(buildFileTree(index, hidden))).toBe(1);
    });

    it('drops directories that end up holding nothing', () => {
        const empty = { ...view, present: new Set(['module:src', 'module:src/lib']) };
        expect(buildFileTree(index, empty)).toEqual([]);
    });

    it('holds what the diff touched inside a file, in source order', () => {
        const [root] = buildFileTree(index, view);
        const util = root.children[0].children.find(child => child.name === 'util.js');
        expect(util.children.map(child => `${child.kind}:${child.name}`)).toEqual(['group:Service', 'leaf:fn()']);
    });

    it('keeps a changed method under the class declaring it', () => {
        const [root] = buildFileTree(index, view);
        const util = root.children[0].children.find(child => child.name === 'util.js');
        const [service] = util.children;
        expect(service.children.map(child => `${child.name}:${child.status}`)).toEqual(['run():changed']);
    });

    it('leaves an untouched declaration out, so a file holds nothing without a diff', () => {
        const [root] = buildFileTree(index, { ...view, status: new Map() });
        const util = root.children[0].children.find(child => child.name === 'util.js');
        expect(util.children).toEqual([]);
    });

    it('counts what it holds', () => {
        expect(countFiles(buildFileTree(index, view))).toBe(3);
    });
});
