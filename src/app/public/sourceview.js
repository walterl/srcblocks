import { blameSide } from './blame.js';
import { codeRows, diffRowsToEntries, highlightLines } from './code.js';
import { diffLines, markChanges, pairLines } from './diff-lines.js';
import { baseSourceOf, isLeaf, sourceOf } from './model.js';

/*
 * A node's source, with line numbers: what a function node shows when it is
 * opened, and what the maximised window shows in full. While a diff is active
 * and the node changed, the base revision's version is diffed against the one
 * the selection shows - in one column or in two.
 */
export function buildSourceBody(node, { source, base, status, diffed, split, blame = null }) {
    const body = document.createElement('div');
    body.className = 'node-body';

    if (source.doc) {
        const doc = document.createElement('pre');
        doc.className = 'node-doc';
        doc.textContent = source.doc;
        if (status === 'changed' && base && base.doc !== source.doc) {
            doc.classList.add('changed');
        }
        body.append(doc);
    }

    if (!diffed) {
        body.append(buildCodeBlock(node, source));
    } else if (split) {
        body.append(buildSideBySide(node, base, source, blame));
    } else {
        body.append(buildInlineDiff(node, base, source, blame));
    }
    return body;
}

const startLine = (node, source) => source.line || node.line || 1;

function buildCodeBlock(node, source) {
    const lines = highlightLines(source.code, node.file);
    const first = startLine(node, source);
    const refs = refsByLine(source.refs);
    return codeRows(lines.map((fragment, index) => ({ fragment, number: first + index, refs: refs.get(index) })));
}

/*
 * A version's refs, by the line of its code they are on, each without that
 * line: `[column, length, target, targetLine?]`, which is what a row takes.
 */
function refsByLine(refs) {
    const byLine = new Map();
    for (const [line, ...ref] of refs || []) {
        if (!byLine.has(line)) {
            byLine.set(line, []);
        }
        byLine.get(line).push(ref);
    }
    return byLine;
}

/*
 * The diff of two versions, each row carrying the refs of the version its text
 * was taken from: a removed line the base's, any other the version on screen's.
 */
function diffWithRefs(base, source) {
    const before = refsByLine(base.refs);
    const after = refsByLine(source.refs);
    const at = { before: 0, after: 0 };

    return diffLines(base.code, source.code).map(row => {
        const refs = row.type === 'removed' ? before.get(at.before) : after.get(at.after);
        if (row.type !== 'added') {
            at.before += 1;
        }
        if (row.type !== 'removed') {
            at.after += 1;
        }
        return { ...row, refs };
    });
}

const baseLine = (node, base) => base.line || node.line || 1;

function buildInlineDiff(node, base, source, blame) {
    const rows = diffWithRefs(base, source);
    return codeRows(
        diffRowsToEntries(rows, node.file, {
            from: startLine(node, source),
            blame: {
                added: blameSide(startLine(node, source), blame?.added),
                removed: blameSide(baseLine(node, base), blame?.removed),
            },
        }),
    );
}

/* Base revision on the left, what the selection shows on the right. */
const buildSideBySide = (node, base, source, blame) =>
    splitColumns(diffWithRefs(base, source), node.file, {
        from: startLine(node, source),
        fromBase: baseLine(node, base),
        blame,
    });

/*
 * Diff rows as two columns: what a run of lines was on the left, what it became
 * on the right. `from` and `fromBase` are the lines each side starts at, since
 * the two revisions number differently.
 *
 * `focus` marks the lines the reader was brought here for, on the side that
 * counts them - the revision on screen, which is the right-hand column.
 */
export function splitColumns(rows, file, { from, fromBase, blame = null, focus = null }) {
    const paired = pairLines(markChanges(rows));
    const split = document.createElement('div');
    split.className = 'code-split';

    const left = columnOf(file, paired, 'left', fromBase, blame?.removed, null);
    const right = columnOf(file, paired, 'right', from, blame?.added, focus);
    split.append(left, right);
    keepLevel(left, right);
    return split;
}

/*
 * Two columns scrolled as one. Each side has its own scrollbar, because each
 * holds its own lines and one long line should not drag the other side out of
 * view - but a diff is read across, so what a line was and what it became have
 * to stay opposite each other.
 *
 * Moving one side moves the other, and the scroll that answers is let through
 * once and ignored, so the two cannot chase each other. A side with less to
 * scroll simply stops at its end.
 */
function keepLevel(left, right) {
    let echo = false;
    const follow = (from, to) =>
        from.addEventListener(
            'scroll',
            () => {
                if (echo) {
                    return;
                }
                echo = true;
                to.scrollLeft = from.scrollLeft;
                requestAnimationFrame(() => {
                    echo = false;
                });
            },
            { passive: true },
        );

    follow(left, right);
    follow(right, left);
}

function columnOf(file, paired, side, first, blame, focus) {
    const lines = highlightLines(paired.map(pair => pair[side]?.text ?? '').join('\n'), file);
    let number = first;

    const column = codeRows(
        paired.map((pair, index) => {
            const row = pair[side];
            if (!row) {
                return { fragment: null, number: null, type: 'empty' };
            }
            // A column holds one side of the diff, so its changed rows are all
            // of the one kind its blame answers for.
            const sha = row.type !== 'context' ? blame?.lines?.[number] : null;
            const entry = {
                fragment: lines[index],
                number,
                type: row.type === 'context' ? null : row.type,
                sha: sha || null,
                commit: sha ? blame.commits[sha] : null,
                focus: Boolean(focus && number >= focus.from && number <= focus.to),
                refs: row.refs,
                changes: row.changes,
            };
            number += 1;
            return entry;
        }),
    );
    column.classList.add('code-side');
    return column;
}

/* Whether a node's source is shown as a diff at all. */
export const showsDiff = (status, base, source) =>
    Boolean(status === 'changed' && base && base.code && base.code !== source.code);

/*
 * What a node shows on the canvas under the current selection: whether it is
 * hidden, whether its source is open, the two versions of that source, and
 * whether they are drawn against each other. The node's header and its menu
 * both offer what this decides, so they decide it the same way.
 */
export function sourceState(node, ui) {
    const hidden = ui.view.hidden.has(node.id);
    const showCode = ui.openSources.has(node.id) && !hidden;
    const status = ui.view.status.get(node.id) || null;
    const leaf = isLeaf(node);
    const source = leaf ? sourceOf(node, ui.selected) : null;
    const base = leaf ? baseSourceOf(node) : null;

    return { hidden, showCode, status, source, base, diffed: Boolean(showCode && showsDiff(status, base, source)) };
}
