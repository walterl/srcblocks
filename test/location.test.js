import { lineRange, vimLocation } from '../src/app/public/model.js';

describe('vimLocation', () => {
    it('puts a declaration on its own line, the way :edit takes it', () => {
        expect(vimLocation({ kind: 'function', file: 'src/a.js', line: 42 })).toBe('+42 src/a.js');
        expect(vimLocation({ kind: 'data', file: 'src/a.js', line: 7 })).toBe('+7 src/a.js');
        expect(vimLocation({ kind: 'group', file: 'src/lib/b.ts', line: 120 })).toBe('+120 src/lib/b.ts');
    });

    it('opens a file and a directory as themselves, with no line to go to', () => {
        expect(vimLocation({ kind: 'file', file: 'src/a.js', line: 1 })).toBe('src/a.js');
        expect(vimLocation({ kind: 'module', path: 'src/lib' })).toBe('src/lib');
    });

    it('escapes the spaces vim would read as the end of the name', () => {
        expect(vimLocation({ kind: 'file', file: 'src/two words.js' })).toBe(String.raw`src/two\ words.js`);
        expect(vimLocation({ kind: 'function', file: 'a b/c.js', line: 3 })).toBe(String.raw`+3 a\ b/c.js`);
    });

    it('has nowhere to send anyone for a node with no file', () => {
        expect(vimLocation({ kind: 'module', path: null })).toBe(null);
    });
});

describe('lineRange', () => {
    it('covers the source a node was shown with, from where it starts', () => {
        expect(lineRange({ line: 10 }, { line: 12, code: 'one\ntwo\nthree' })).toEqual({ from: 12, to: 14 });
    });

    it('falls back to the node itself when the selection shows no source', () => {
        expect(lineRange({ line: 10 }, null)).toEqual({ from: 10, to: 10 });
    });

    it('is a single line for a node that holds no source of its own', () => {
        expect(lineRange({ line: 7 }, { line: 7, code: '' })).toEqual({ from: 7, to: 7 });
    });

    it('covers a class by where it ends, since its body is what it holds', () => {
        expect(lineRange({ kind: 'group', line: 12, endLine: 48 }, null)).toEqual({ from: 12, to: 48 });
    });

    it('ignores an end that comes before the start', () => {
        expect(lineRange({ line: 30, endLine: 4 }, null)).toEqual({ from: 30, to: 30 });
    });

    it('starts at the top of the file when nothing says otherwise', () => {
        expect(lineRange({}, null)).toEqual({ from: 1, to: 1 });
    });
});
