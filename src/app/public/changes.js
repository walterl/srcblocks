import { displayName } from './model.js';

/*
 * What a branch does to the shape of the code, at a glance: the signatures and
 * exports that make up its interfaces, and the structures that hold its data.
 * Each says plainly whether it was added, changed or removed, what about it
 * changed, and links to it on the canvas. The toggles above hide either type.
 */
export function createChangesWindow({ root, title, filters, list, close, onJump, onToggleKind }) {
    close.addEventListener('click', () => root.setAttribute('hidden', ''));

    return {
        hide() {
            root.setAttribute('hidden', '');
        },

        show(items, counts, hidden) {
            root.removeAttribute('hidden');
            const shown = items.filter(item => !hidden.has(item.type));
            title.textContent = `${shown.length} of ${items.length} ${items.length === 1 ? 'change' : 'changes'}`;

            filters.replaceChildren(
                ...[...counts.entries()].map(([type, total]) => filter(type, total, hidden, onToggleKind)),
            );
            list.replaceChildren(
                ...(shown.length ? byFile(shown).map(group => buildFileGroup(group, onJump)) : [empty(items.length)]),
            );
            list.scrollTop = 0;
        },
    };
}

/* Items arrive in diff order, so a run of them shares a file. */
function byFile(items) {
    const groups = [];
    for (const item of items) {
        const last = groups[groups.length - 1];
        if (last && last.file === item.file) {
            last.items.push(item);
        } else {
            groups.push({ file: item.file, items: [item] });
        }
    }
    return groups;
}

function buildFileGroup({ file, items }, onJump) {
    const group = document.createElement('li');
    group.className = 'changes-file';
    group.append(label('changes-file-path', file));

    const list = document.createElement('ul');
    list.className = 'changes-file-items';
    list.replaceChildren(...items.map(item => entry(item, onJump)));
    group.append(list);
    return group;
}

function filter(kind, total, hidden, onToggleKind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'changes-filter';
    button.setAttribute('aria-pressed', String(!hidden.has(kind)));
    button.textContent = `${kind} ${total}`;
    button.addEventListener('click', () => onToggleKind(kind));
    return button;
}

function entry({ node, type, status, detail, path, line }, onJump) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'changes-entry';
    button.addEventListener('click', () => onJump(node.id));

    const heading = document.createElement('div');
    heading.className = 'changes-entry-heading';
    heading.append(
        label(`changes-status status-${status}`, status),
        label('changes-type', type),
        label(`changes-name status-${status}`, displayName(node)),
    );
    button.append(heading);

    for (const detailLine of detail) {
        button.append(
            label(`changes-detail tone-${detailLine.tone}`, `${TONE_MARK[detailLine.tone] || ''}${detailLine.text}`),
        );
    }
    button.append(label('changes-where', `line ${line}`));
    button.title = path;
    item.append(button);
    return item;
}

const TONE_MARK = { added: '+ ', removed: '− ', note: '' };

const empty = total => {
    const item = document.createElement('li');
    item.className = 'changes-empty';
    item.textContent = total ? 'Both types are hidden.' : 'The selected commits change no interface or data structure.';
    return item;
};

function label(className, text) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
}
