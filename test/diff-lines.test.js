import { countChanges, diffLines, hasChanges, markChanges, pairLines } from '../src/app/public/diff-lines.js';

const render = rows => rows.map(row => `${{ context: ' ', added: '+', removed: '-' }[row.type]}${row.text}`);

describe('diffLines', () => {
    it('reports no change for identical sources', () => {
        const rows = diffLines('a\nb', 'a\nb');
        expect(hasChanges(rows)).toBe(false);
        expect(render(rows)).toEqual([' a', ' b']);
    });

    it('marks inserted lines', () => {
        expect(render(diffLines('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c']);
    });

    it('marks deleted lines', () => {
        expect(render(diffLines('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c']);
    });

    it('shows a replaced line as a deletion and an insertion', () => {
        expect(render(diffLines('a\nb\nc', 'a\nB\nc'))).toEqual([' a', '-b', '+B', ' c']);
    });

    it('keeps the common lines of a rewritten body', () => {
        const before = 'function f() {\n    const a = 1;\n    return a;\n}';
        const after = 'function f() {\n    const a = 2;\n    log(a);\n    return a;\n}';
        expect(render(diffLines(before, after))).toEqual([
            ' function f() {',
            '-    const a = 1;',
            '+    const a = 2;',
            '+    log(a);',
            '     return a;',
            ' }',
        ]);
    });
});

describe('pairLines', () => {
    const shape = paired =>
        paired.map(pair => `${pair.left ? pair.left.text : '-'}|${pair.right ? pair.right.text : '-'}`);

    it('puts context on both sides', () => {
        expect(shape(pairLines(diffLines('a\nb', 'a\nb')))).toEqual(['a|a', 'b|b']);
    });

    it('pairs a replaced line with its replacement', () => {
        expect(shape(pairLines(diffLines('a\nb\nc', 'a\nB\nc')))).toEqual(['a|a', 'b|B', 'c|c']);
    });

    it('pads the shorter side of an uneven run', () => {
        expect(shape(pairLines(diffLines('a\nb\nc\nd', 'a\nX\nd')))).toEqual(['a|a', 'b|X', 'c|-', 'd|d']);
    });

    it('leaves the left side empty for a pure insertion', () => {
        expect(shape(pairLines(diffLines('a\nc', 'a\nb\nc')))).toEqual(['a|a', '-|b', 'c|c']);
    });
});

describe('countChanges', () => {
    it('counts each side of a diff', () => {
        expect(countChanges(diffLines('a\nb\nc', 'a\nB\nc\nd'))).toEqual({ added: 2, removed: 1 });
    });

    it('counts nothing where nothing changed', () => {
        expect(countChanges(diffLines('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 });
    });
});

describe('markChanges', () => {
    // Each line with its changed stretches in brackets.
    const marks = rows =>
        markChanges(rows).map(row => {
            let text = row.text;
            for (const [start, end] of [...(row.changes || [])].reverse()) {
                text = `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;
            }
            return text;
        });

    it('marks the words that changed on each side of an edited line', () => {
        expect(marks(diffLines('const a = 1;', 'const b = 1;'))).toEqual(['const [a] = 1;', 'const [b] = 1;']);
    });

    it('marks a run of changed words as one stretch', () => {
        expect(marks(diffLines('foo.bar();', 'foo.baz.qux();'))).toEqual(['foo.[bar]();', 'foo.[baz.qux]();']);
    });

    it('marks only what was inserted when nothing was taken out', () => {
        expect(marks(diffLines('log(a);', 'log(a, b);'))).toEqual(['log(a);', 'log(a[, b]);']);
    });

    it('pairs the lines of a replaced run in order', () => {
        expect(marks(diffLines('x = 1;\ny = 2;', 'x = 10;\ny = 20;'))).toEqual([
            'x = [1];',
            'y = [2];',
            'x = [10];',
            'y = [20];',
        ]);
    });

    it('leaves context and unpaired lines unmarked', () => {
        const rows = markChanges(diffLines('a\nb = 1;', 'a\nb = 2;\nc = 3;'));
        expect(rows.map(row => row.changes || null)).toEqual([null, [[4, 5]], [[4, 5]], null]);
    });

    it('leaves lines with little in common unmarked', () => {
        const rows = markChanges(diffLines('const a = 1;', 'throw new Error(message);'));
        expect(rows.every(row => !row.changes)).toBe(true);
    });

    it('does not change the rows it is given', () => {
        const rows = diffLines('a = 1;', 'a = 2;');
        markChanges(rows);
        expect(rows.every(row => !row.changes)).toBe(true);
    });
});
