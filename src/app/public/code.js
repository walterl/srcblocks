import { blameRows } from './blame.js';
import { markChanges } from './diff-lines.js';
import hljs from '/vendor/highlight/core.mjs';
import javascript from '/vendor/highlight/es/languages/javascript.js';
import typescript from '/vendor/highlight/es/languages/typescript.js';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);

const languageFor = file => (/\.(ts|tsx|mts|cts)$/.test(file || '') ? 'typescript' : 'javascript');

/* Syntax-highlighted HTML for a piece of source. */
export const highlight = (code, file) =>
    hljs.highlight(code, { language: languageFor(file), ignoreIllegals: true }).value;

/*
 * The same, split into one fragment per line so each line can carry its own
 * number and diff marker.
 *
 * Highlighting is done over the whole snippet - a block comment or template
 * literal has to keep its colour across line breaks - and the result is split
 * afterwards by walking the DOM, reopening the spans that were still open at
 * the end of a line.
 */
export function highlightLines(code, file) {
    const source = document.createElement('div');
    source.innerHTML = highlight(code, file);

    const lines = [];
    let line = document.createDocumentFragment();
    let open = [];

    const target = () => (open.length ? open[open.length - 1].clone : line);

    const breakLine = () => {
        lines.push(line);
        line = document.createDocumentFragment();
        let parent = line;
        open = open.map(entry => {
            const clone = entry.element.cloneNode(false);
            parent.append(clone);
            parent = clone;
            return { element: entry.element, clone };
        });
    };

    const visit = node => {
        if (node.nodeType === Node.TEXT_NODE) {
            node.data.split('\n').forEach((part, index) => {
                if (index > 0) {
                    breakLine();
                }
                if (part) {
                    target().append(document.createTextNode(part));
                }
            });
            return;
        }
        const clone = node.cloneNode(false);
        target().append(clone);
        open.push({ element: node, clone });
        for (const child of node.childNodes) {
            visit(child);
        }
        open.pop();
    };

    for (const child of source.childNodes) {
        visit(child);
    }
    lines.push(line);
    return lines;
}

const MARKER = { added: '+', removed: '−', empty: '' };

/*
 * Renders lines of source as numbered rows: `{ fragment, number, type, focus,
 * refs, changes }` each, where `type` marks a diff row and `focus` marks a line
 * the reader was brought here for. The two are independent - a file opened at a
 * function shows which lines are that function's and what the branch did to
 * them at once. `refs` are the names on the line that lead to a definition, and
 * `changes` the stretches of a diff row that its counterpart does not share.
 * Shared by the source shown inside a function node and by the windows.
 */
export function codeRows(entries) {
    const block = document.createElement('pre');
    block.className = 'node-code hljs';

    for (const entry of entries) {
        const row = document.createElement('div');
        row.className = ['code-row', entry.type ? `line-${entry.type}` : '', entry.focus ? 'line-focus' : '']
            .filter(Boolean)
            .join(' ');
        row.append(
            span('code-number', entry.number === null || entry.number === undefined ? '' : String(entry.number)),
            span('code-marker', MARKER[entry.type] || ''),
        );

        const code = document.createElement('code');
        code.className = 'code-text';
        code.append(entry.fragment || document.createTextNode(''));
        if (entry.refs) {
            linkNames(code, entry.refs);
        }
        if (entry.changes) {
            markRanges(code, entry.changes);
        }
        row.append(code);

        // Why the line reads like this: the commit that wrote it, one click
        // from the message that explains it.
        if (entry.sha) {
            row.append(blameChip(entry.sha, entry.commit));
        }
        block.append(row);
    }
    return block;
}

/*
 * Wraps each name that has a definition in an element saying where it is, so
 * that holding ctrl can make it a link. A ref is `[column, length, target,
 * targetLine?]`. The highlighter keeps a name in one piece, so a name split
 * across two of its spans is not a name, and is left alone.
 */
function linkNames(code, refs) {
    for (const [column, length, target, targetLine] of refs) {
        const found = textAt(code, column, length);
        if (!found) {
            continue;
        }
        const name = found.node.splitText(found.offset);
        name.splitText(length);

        const link = document.createElement('span');
        link.className = 'code-ref';
        link.dataset.target = target;
        if (targetLine) {
            link.dataset.line = String(targetLine);
        }
        name.replaceWith(link);
        link.append(name);
    }
}

/*
 * Wraps each `[start, end)` stretch of a line's columns in an element of its
 * own. A stretch can cross the highlighter's spans and the names linked above,
 * so it is wrapped piece by piece, one text node at a time.
 */
function markRanges(code, ranges) {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const texts = [];
    let column = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        texts.push({ node, start: column });
        column += node.data.length;
    }

    for (const { node, start } of texts) {
        // Last stretch first, so splitting a node leaves the earlier offsets
        // in what remains of it.
        for (const [from, to] of [...ranges].reverse()) {
            const begin = Math.max(from - start, 0);
            const end = Math.min(to - start, node.data.length);
            if (begin >= end) {
                continue;
            }
            const piece = node.splitText(begin);
            piece.splitText(end - begin);

            const mark = document.createElement('span');
            mark.className = 'code-change';
            piece.replaceWith(mark);
            mark.append(piece);
        }
    }
}

/* The text node holding `length` characters from `column` of a line, whole. */
function textAt(root, column, length) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let start = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const end = start + node.data.length;
        if (column >= start && column + length <= end) {
            return { node, offset: column - start };
        }
        if (column < end) {
            return null;
        }
        start = end;
    }
    return null;
}

/*
 * The row numbered `line` in source drawn by `codeRows`: in a split, the
 * right-hand column's, since that is the revision on screen.
 */
export const rowForLine = (root, line) =>
    [...root.querySelectorAll('.code-row')].find(
        row =>
            !row.closest('.code-side:first-child') && row.querySelector('.code-number')?.textContent === String(line),
    ) || null;

function blameChip(sha, commit) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'code-blame';
    chip.dataset.sha = sha;
    chip.textContent = commit?.shortSha || sha.slice(0, 7);
    chip.title = commit ? `${commit.subject}\n${commit.author} · ${new Date(commit.date).toLocaleString()}` : sha;
    return chip;
}

function span(className, text) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
}

/*
 * Turns diff rows into code rows: the numbers follow one side of the diff, the
 * side that has a line on every row.
 *
 * Both sides are counted even so, because both are blamed: a new line at the
 * revision that wrote it, a removed line at the revision that still has it.
 */
export function diffRowsToEntries(diffRows, file, { from, numbering = 'added', blame = null }) {
    const rows = markChanges(diffRows);
    const lines = highlightLines(rows.map(row => row.text).join('\n'), file);
    const skip = numbering === 'added' ? 'removed' : 'added';
    const blamed = blameRows(rows, blame);
    let number = from;

    return rows.map((row, index) => {
        const numbered = from !== null && row.type !== skip;
        const entry = {
            fragment: lines[index],
            number: numbered ? number : null,
            type: row.type === 'context' ? null : row.type,
            refs: row.refs,
            changes: row.changes,
            sha: blamed[index]?.sha || null,
            commit: blamed[index]?.commit || null,
        };
        if (numbered) {
            number += 1;
        }
        return entry;
    });
}
