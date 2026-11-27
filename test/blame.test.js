import { parseBlame } from '../src/analyze/blame.js';
import { blameRows, createBlame } from '../src/app/public/blame.js';

/* Two lines from one commit, one from another, in porcelain order. */
const porcelain = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 12 2',
    'author Ada Lovelace',
    'author-time 1700000000',
    'author-tz +0000',
    'summary Teach the crawler to stop',
    'filename src/crawl.js',
    '\tconst limit = 10;',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 11 13 2',
    '\tconst wait = 20;',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 4 14 1',
    'author Grace Hopper',
    'author-time 1700100000',
    'summary Drop the queue',
    'filename src/crawl.js',
    '\treturn limit;',
].join('\n');

describe('parseBlame', () => {
    const { lines, commits } = parseBlame(porcelain);

    it('maps every line of the revision to the commit that wrote it', () => {
        expect(lines).toEqual({ 12: 'a'.repeat(40), 13: 'a'.repeat(40), 14: 'b'.repeat(40) });
    });

    it('describes each commit once, however many lines it wrote', () => {
        expect(Object.keys(commits)).toHaveLength(2);
        expect(commits['a'.repeat(40)]).toMatchObject({
            shortSha: 'aaaaaaa',
            subject: 'Teach the crawler to stop',
            author: 'Ada Lovelace',
        });
        expect(commits['b'.repeat(40)].subject).toBe('Drop the queue');
    });

    it('reads the author time as a date', () => {
        expect(commits['a'.repeat(40)].date).toBe(new Date(1700000000 * 1000).toISOString());
    });
});

describe('blameRows', () => {
    /* Two revisions of the same file: the base, and what the branch made of it. */
    const before = { lines: { 40: 'old1', 41: 'old2', 42: 'old3' }, commits: { old1: {}, old2: {}, old3: {} } };
    const after = { lines: { 60: 'new1', 61: 'new2', 62: 'new3' }, commits: { new1: {}, new2: {}, new3: {} } };
    const blame = { added: { from: 60, ...after }, removed: { from: 40, ...before } };

    const rows = [
        { type: 'context', text: 'kept' },
        { type: 'removed', text: 'gone' },
        { type: 'added', text: 'fresh' },
        { type: 'context', text: 'kept too' },
    ];

    it('blames a new line at the revision that wrote it', () => {
        // The added row is the second line of the new side: 60, then 61.
        expect(blameRows(rows, blame)[2].sha).toBe('new2');
    });

    it('blames a removed line at the revision that still has it', () => {
        expect(blameRows(rows, blame)[1].sha).toBe('old2');
    });

    it('leaves untouched lines alone, and counts them on both sides', () => {
        const [first, , , last] = blameRows(rows, blame);
        expect(first).toBe(null);
        expect(last).toBe(null);
        // The context row consumed line 40 of the base, and the removed row 41,
        // so a second removed row lands on 42 - the added row in between does
        // not move the base side along.
        const withAnother = [...rows.slice(0, 3), { type: 'removed', text: 'also gone' }, rows[3]];
        expect(blameRows(withAnother, blame)[3].sha).toBe('old3');
    });

    it('carries the commit each line belongs to', () => {
        const described = { lines: { 1: 'sha' }, commits: { sha: { shortSha: 'sha', subject: 'Say why' } } };
        const [row] = blameRows([{ type: 'added', text: 'x' }], { added: { from: 1, ...described } });
        expect(row.commit.subject).toBe('Say why');
    });

    it('has no answer for a side it was given no blame for', () => {
        const oneSided = { added: { from: 60, ...after }, removed: null };
        expect(blameRows(rows, oneSided).map(row => row?.sha || null)).toEqual([null, null, 'new2', null]);
        expect(blameRows(rows, null).every(row => row === null)).toBe(true);
    });
});

describe('createBlame', () => {
    const answer = { lines: { 1: 'sha' }, commits: { sha: { shortSha: 'sha' } } };

    const build = (fetch, onLoaded = () => {}) => createBlame({ fetch, onLoaded });

    it('has nothing to offer before the first answer arrives', async () => {
        const asked = [];
        const blame = build(async (path, ref) => {
            asked.push([path, ref]);
            return answer;
        });

        expect(blame.of('a.js', 'c1')).toBe(null);
        await blame.load([{ path: 'a.js', ref: 'c1' }]);
        expect(blame.of('a.js', 'c1')).toBe(answer);
        expect(asked).toEqual([['a.js', 'c1']]);
    });

    it('asks for a file revision once, however many views want it', async () => {
        let calls = 0;
        const blame = build(async () => {
            calls += 1;
            return answer;
        });

        blame.of('a.js', 'c1');
        blame.of('a.js', 'c1');
        await blame.load([{ path: 'a.js', ref: 'c1' }]);
        expect(calls).toBe(1);
    });

    it('tells the caller to draw again once an answer is in', async () => {
        let drawn = 0;
        const blame = build(
            async () => answer,
            () => {
                drawn += 1;
            },
        );

        blame.of('a.js', 'c1');
        await blame.load([{ path: 'a.js', ref: 'c1' }]);
        await Promise.resolve();
        expect(drawn).toBe(1);
    });

    it('keeps drawing when blame cannot be had', async () => {
        const blame = build(async () => {
            throw new Error('no such revision');
        });

        await blame.load([{ path: 'a.js', ref: 'c1' }]);
        expect(blame.of('a.js', 'c1')).toEqual({ lines: {}, commits: {} });
    });

    it('asks for nothing when there is no revision to blame at', async () => {
        let calls = 0;
        const blame = build(async () => {
            calls += 1;
            return answer;
        });

        expect(blame.of('a.js', null)).toBe(null);
        await blame.load([{ path: 'a.js', ref: null }]);
        expect(calls).toBe(0);
    });
});
