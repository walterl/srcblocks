import { codeRows, diffRowsToEntries } from './code.js';
import { displayName } from './model.js';

/*
 * The whole of the loaded diff in one window: every changed function, grouped by
 * the file it lives in. A hunk's heading is a link to the function it belongs
 * to - following it closes the window and takes the canvas there.
 */
const STATUS_LABEL = { added: 'new', changed: 'changed', removed: 'removed' };

export function createDiffWindow({ root, title, body, close, onJump }) {
    const hide = () => root.setAttribute('hidden', '');
    close.addEventListener('click', hide);

    return {
        hide,

        show(files, caption, { note = null, empty = 'Nothing changed under the selected commits.' } = {}) {
            root.removeAttribute('hidden');
            title.textContent = caption;

            body.replaceChildren(
                ...(note ? [buildNote(note)] : []),
                ...(files.length
                    ? files.map(file =>
                          buildFile(file, {
                              onJump: id => {
                                  hide();
                                  onJump(id);
                              },
                          }),
                      )
                    : [message(empty)]),
            );
            body.scrollTop = 0;
        },
    };
}

function buildFile({ file, hunks }, handlers) {
    const section = document.createElement('section');
    section.className = 'diff-file';
    section.append(text('diff-file-path', file));
    for (const hunk of hunks) {
        section.append(buildHunk(hunk, handlers));
    }
    return section;
}

function buildHunk(hunk, { onJump }) {
    const { node, label, status, rows, from, numbering, added, removed, documentation, blame } = hunk;
    const article = document.createElement('article');
    article.className = 'diff-hunk';

    // A hunk of a file the graph holds no node for - a config, a document -
    // reads the same, but leads nowhere.
    const heading = document.createElement(node ? 'button' : 'div');
    heading.className = 'diff-hunk-heading';
    if (node) {
        heading.type = 'button';
        heading.title = `Go to ${node.file}:${node.line}`;
        heading.addEventListener('click', () => onJump(node.id));
    }
    heading.append(
        text(`diff-hunk-name status-${status}`, label || (node ? displayName(node) : hunk.file)),
        text('diff-hunk-status', documentation ? 'documentation' : STATUS_LABEL[status]),
        text('diff-hunk-counts', `+${added} −${removed}`),
    );

    article.append(
        heading,
        codeRows(diffRowsToEntries(rows, node ? node.file : hunk.file, { from, numbering, blame })),
    );
    return article;
}

/* A commit's own words, above its diff: the answer to "why". */
function buildNote(note) {
    const element = document.createElement('pre');
    element.className = 'diff-note';
    element.textContent = note;
    return element;
}

const text = (className, content) => {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = content;
    return element;
};

const message = text => {
    const element = document.createElement('p');
    element.className = 'diff-empty';
    element.textContent = text;
    return element;
};
