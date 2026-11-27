/*
 * Line diff for the source shown inside a function node. Function bodies are
 * small, so a plain longest-common-subsequence table is the simplest thing that
 * gives a stable, minimal diff.
 */
export const diffLines = (before, after) => diffSequences(before.split('\n'), after.split('\n'));

/* Two sequences diffed item by item: `{ type, text }` for each item of either. */
function diffSequences(before, after) {
    const lengths = lcsTable(before, after);

    const rows = [];
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (before[i] === after[j]) {
            rows.push({ type: 'context', text: after[j] });
            i += 1;
            j += 1;
        } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
            rows.push({ type: 'removed', text: before[i] });
            i += 1;
        } else {
            rows.push({ type: 'added', text: after[j] });
            j += 1;
        }
    }
    while (i < before.length) {
        rows.push({ type: 'removed', text: before[i] });
        i += 1;
    }
    while (j < after.length) {
        rows.push({ type: 'added', text: after[j] });
        j += 1;
    }

    return rows;
}

function lcsTable(a, b) {
    const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
        }
    }
    return lengths;
}

export const hasChanges = rows => rows.some(row => row.type !== 'context');

/* How many lines a diff adds and removes, the way a diff reports it. */
export const countChanges = rows => ({
    added: rows.filter(row => row.type === 'added').length,
    removed: rows.filter(row => row.type === 'removed').length,
});

/*
 * Pairs a unified diff into two columns: what a run of lines was on the left,
 * what it became on the right, with the shorter side padded so both columns
 * keep the same rows.
 */
export function pairLines(rows) {
    const paired = [];
    let removed = [];
    let added = [];

    const flush = () => {
        for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
            paired.push({ left: removed[index] || null, right: added[index] || null });
        }
        removed = [];
        added = [];
    };

    for (const row of rows) {
        if (row.type === 'removed') {
            removed.push(row);
        } else if (row.type === 'added') {
            added.push(row);
        } else {
            flush();
            paired.push({ left: row, right: row });
        }
    }
    flush();

    return paired;
}

/*
 * Marks what changed inside each replaced line: a removed line and the added
 * line it is paired with (the same pairing `pairLines` draws side by side) are
 * diffed word by word, and each gets `changes`, the `[start, end)` columns of
 * its own text that the other line does not share.
 *
 * Two lines with little in common are a line taken out and an unrelated one
 * put in rather than one line edited, and marking nearly all of both would
 * say nothing, so they are left unmarked - as are lines with no partner.
 */
export function markChanges(rows) {
    const marked = rows.slice();
    let removed = [];
    let added = [];

    const flush = () => {
        for (let index = 0; index < Math.min(removed.length, added.length); index += 1) {
            const changes = changesBetween(rows[removed[index]].text, rows[added[index]].text);
            if (!changes) {
                continue;
            }
            marked[removed[index]] = { ...rows[removed[index]], changes: changes.before };
            marked[added[index]] = { ...rows[added[index]], changes: changes.after };
        }
        removed = [];
        added = [];
    };

    rows.forEach((row, index) => {
        if (row.type === 'removed') {
            removed.push(index);
        } else if (row.type === 'added') {
            added.push(index);
        } else {
            flush();
        }
    });
    flush();

    return marked;
}

/* Words, runs of whitespace and single punctuation marks: what an edit is made of. */
const tokensOf = text => text.match(/\w+|\s+|[^\w\s]/g) || [];

/* Past this many token pairs a line is generated or minified, and not worth a table. */
const MAX_TOKEN_PAIRS = 250000;

/* How much of two lines has to be shared for one to read as an edit of the other. */
const MIN_SIMILARITY = 0.5;

/* The changed columns of each of two lines, or null when they are not worth marking. */
function changesBetween(before, after) {
    const a = tokensOf(before);
    const b = tokensOf(after);
    if (a.length * b.length > MAX_TOKEN_PAIRS) {
        return null;
    }

    const ranges = { before: [], after: [] };
    const at = { before: 0, after: 0 };
    let shared = 0;
    for (const { type, text } of diffSequences(a, b)) {
        if (type === 'context') {
            shared += text.length;
            at.before += text.length;
            at.after += text.length;
        } else {
            const side = type === 'removed' ? 'before' : 'after';
            extend(ranges[side], at[side], at[side] + text.length);
            at[side] += text.length;
        }
    }

    const similarity = (2 * shared) / (before.length + after.length);
    return similarity >= MIN_SIMILARITY ? ranges : null;
}

/* Adds a range to a list, merged into the last one when the two touch. */
function extend(ranges, start, end) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === start) {
        last[1] = end;
    } else {
        ranges.push([start, end]);
    }
}
