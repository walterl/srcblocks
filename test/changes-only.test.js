import { deriveViewState, indexGraph, restrictToChanges, revealIn } from '../src/app/public/model.js';

const fn = (id, parent, extra = {}) => ({ id, kind: 'function', name: id, parent, inBase: true, ...extra });

const index = indexGraph({
    nodes: [
        { id: 'module:src', kind: 'module', name: 'src', parent: null, inBase: true },
        { id: 'file:touched.js', kind: 'file', name: 'touched.js', parent: 'module:src', inBase: true },
        { id: 'file:quiet.js', kind: 'file', name: 'quiet.js', parent: 'module:src', inBase: true },
        { id: 'file:new.js', kind: 'file', name: 'new.js', parent: 'module:src', inBase: false },
        fn('changed', 'file:touched.js'),
        fn('untouched', 'file:touched.js'),
        fn('quiet', 'file:quiet.js'),
        fn('inNewFile', 'file:new.js', { inBase: false }),
    ],
    edges: [
        { id: 'changed->untouched', source: 'changed', target: 'untouched', inBase: true },
        { id: 'changed->inNewFile', source: 'changed', target: 'inNewFile', inBase: false },
        { id: 'quiet->untouched', source: 'quiet', target: 'untouched', inBase: true },
    ],
});

const analysis = {
    commits: [{ sha: 'c1' }],
    perCommit: {
        c1: {
            nodes: { changed: 'changed', 'file:new.js': 'added', inNewFile: 'added' },
            edges: { 'changed->inNewFile': 'added' },
        },
    },
};

const full = deriveViewState(index, analysis, new Set(['c1']));
const restricted = restrictToChanges(index, full);

describe('restrictToChanges', () => {
    it('keeps what the branch touched and the containers holding it', () => {
        expect([...restricted.present].sort()).toEqual(
            ['changed', 'file:new.js', 'file:touched.js', 'inNewFile', 'module:src'].sort(),
        );
    });

    it('drops functions and files the branch left alone', () => {
        expect(restricted.present.has('untouched')).toBe(false);
        expect(restricted.present.has('quiet')).toBe(false);
        expect(restricted.present.has('file:quiet.js')).toBe(false);
    });

    it('keeps calls only while both ends survive', () => {
        expect([...restricted.edgePresent]).toEqual(['changed->inNewFile']);
    });

    it('leaves the full view alone', () => {
        expect(full.present.has('untouched')).toBe(true);
    });
});

describe('revealIn', () => {
    const revealed = revealIn(index, restricted, new Set(['quiet']));

    it('puts a node the filter dropped back, with what holds it', () => {
        expect(revealed.present.has('quiet')).toBe(true);
        expect(revealed.present.has('file:quiet.js')).toBe(true);
    });

    it('brings back nothing else', () => {
        expect(revealed.present.has('untouched')).toBe(false);
        expect(restricted.present.has('quiet')).toBe(false);
    });
});
