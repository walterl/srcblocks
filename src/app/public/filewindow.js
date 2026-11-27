import { blameSide } from './blame.js';
import { codeRows, diffRowsToEntries, highlightLines } from './code.js';
import { countChanges } from './diff-lines.js';
import { element } from './dom.js';
import { nodeDiffStat, nodeDiffViewToggle } from './nodechrome.js';
import { splitColumns } from './sourceview.js';

/*
 * A node at the size of the canvas, which for every node is the file it lives
 * in: a declaration's file opened at the declaration, a class's at its methods,
 * a file's at the top.
 *
 * The canvas shows declarations, and a declaration read on its own leaves out
 * what surrounds it - the imports above it, the helper below it, the comment
 * between them. This is that context, and the node's own lines are picked out of
 * the page so it is clear which part of it you came for.
 *
 * `DIFF` chooses what the lines are. Off, they are the file as it stands under
 * the current commit selection - the code that actually runs. On, they are what
 * the branch did to it, whole: every line, with the removals still among them,
 * in one column or two. That is where a change the canvas has no node for - an
 * import, a comment between two functions - is visible among what surrounds it.
 */
export function createFileWindow({ root, title, body, close, onToggleDiff, onToggleDiffView }) {
    let shown = null;
    const hide = () => {
        shown = null;
        root.setAttribute('hidden', '');
        document.body.classList.remove('reading-source');
    };
    close.addEventListener('click', hide);

    return {
        hide,

        get nodeId() {
            return shown;
        },

        show({ node, path, ref, code, diff = null, blame = null, focus = null, diffing, split }) {
            shown = node.id;
            root.removeAttribute('hidden');
            document.body.classList.add('reading-source');

            const reading = diffing && diff ? diff : null;

            // What the diff did to this file is a fact about the file, so it is
            // said whichever way the switch is set - and it is counted off the
            // lines the window has, not off the nodes the canvas drew. The two
            // do not agree: a file's diff carries what happened between its
            // declarations as well as inside them.
            const stat = diff && countChanges(diff.rows);
            const controls = element('span', 'code-window-actions');
            controls.append(
                ...(stat?.added || stat?.removed ? [nodeDiffStat(stat)] : []),
                diffToggle(diffing, Boolean(diff), onToggleDiff),
                ...(reading ? [nodeDiffViewToggle(split, onToggleDiffView)] : []),
            );

            title.replaceChildren(
                label('code-window-name', path),
                label('code-window-where', where(ref, diff, focus)),
                controls,
            );

            body.replaceChildren(reading ? diffRows(path, reading, blame, focus, split) : plainRows(path, code, focus));

            // The point of opening the file here is the lines that were asked
            // for, so the window opens on them rather than at the top.
            const first = body.querySelector('.line-focus');
            body.scrollTop = 0;
            if (first) {
                first.scrollIntoView({ block: 'center' });
            }
        },
    };
}

/*
 * Whether the lines are the diff's work or the code as it stands. Always
 * offered, so the window reads the same way whatever is open in it.
 *
 * What decides whether it can be asked is whether a diff is loaded at all -
 * not whether this particular file is in it. Most of the files a diff is read
 * against are untouched, and asking what happened to one of them is a fair
 * question with `nothing` for an answer.
 */
function diffToggle(diffing, canDiff, onToggleDiff) {
    const button = element('button', 'window-diff', 'diff');
    button.type = 'button';
    button.disabled = !canDiff;
    button.setAttribute('aria-pressed', String(Boolean(diffing && canDiff)));
    button.title = !canDiff
        ? 'No diff is loaded: choose a branch to read this against'
        : diffing
          ? 'Show the file as it stands'
          : 'Show what the diff did to the file';
    button.addEventListener('click', () => onToggleDiff());
    return button;
}

const inFocus = (number, focus) => Boolean(focus && number !== null && number >= focus.from && number <= focus.to);

/* The file as it stands, numbered from the top. */
function plainRows(path, code, focus) {
    const lines = highlightLines(code, path);
    return codeRows(
        lines.map((fragment, index) => ({ fragment, number: index + 1, focus: inFocus(index + 1, focus) })),
    );
}

/*
 * The file as its own diff, whole. Both sides start at line one, since this is
 * every line of the file rather than a hunk out of the middle of it.
 */
function diffRows(path, diff, blame, focus, split) {
    const sides = {
        added: blameSide(1, blame?.added),
        removed: blameSide(1, blame?.removed),
    };
    if (split) {
        return splitColumns(diff.rows, path, { from: 1, fromBase: 1, blame: sides, focus });
    }

    const entries = diffRowsToEntries(diff.rows, path, { from: 1, numbering: diff.numbering, blame: sides });
    return codeRows(entries.map(entry => ({ ...entry, focus: inFocus(entry.number, focus) })));
}

const where = (ref, diff, focus) => {
    const revision = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
    // Most files a branch is read against are untouched, and say nothing.
    const at = diff?.status ? `${revision} · ${diff.status}` : revision;
    if (!focus) {
        return at;
    }
    return focus.from === focus.to ? `${at} · line ${focus.from}` : `${at} · lines ${focus.from}–${focus.to}`;
};

function label(className, text) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
}
