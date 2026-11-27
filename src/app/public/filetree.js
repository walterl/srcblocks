/*
 * The files on the canvas, as a tree, with whatever the diff touched inside
 * them - a changed function, a class and its changed methods. Clicking a row
 * takes the canvas to it; the chevron folds it away. What is folded is
 * remembered by id, so the tree keeps its shape as the diff underneath it
 * changes, and anything with something to show under it starts open.
 */
export function createFileTree({ root, onSelect, onFold = () => {} }) {
    const collapsed = new Set();

    const render = tree => {
        root.replaceChildren(...tree.map(node => branch(node, 0)));
        // What is folded decides what folding the whole tree still has to do.
        onFold();
    };

    const branch = (node, depth) => {
        const element = document.createElement('div');
        element.className = `tree-node tree-${node.kind}`;

        const row = document.createElement('button');
        row.type = 'button';
        row.className = ['tree-row', node.status ? `status-${node.status}` : ''].filter(Boolean).join(' ');
        row.style.paddingLeft = `${depth * 12 + 6}px`;
        row.title = node.title || node.id;

        const open = Boolean(node.children.length) && !collapsed.has(node.id);

        // A directory is only a way through the tree; everything else is a
        // place on the canvas, so its row leads there and its chevron folds it.
        if (node.kind === 'dir') {
            row.append(label('tree-chevron', open ? '▾' : '▸'), label('tree-name', node.name));
            row.addEventListener('click', () => toggle(node, open));
        } else {
            row.append(chevron(node, open), label('tree-name', node.name));
            row.addEventListener('click', () => onSelect(node.id));
        }

        element.append(row);
        if (!open) {
            return element;
        }

        // What the diff touched inside a file is not part of the tree of paths
        // above it, and reads better fenced off from it.
        const children = node.children.map(child => branch(child, depth + 1));
        if (node.kind === 'file') {
            element.append(boxed(children));
        } else {
            element.append(...children);
        }
        return element;
    };

    const boxed = children => {
        const box = document.createElement('div');
        box.className = 'tree-inside';
        box.append(...children);
        return box;
    };

    const toggle = (node, open) => {
        if (open) {
            collapsed.add(node.id);
        } else {
            collapsed.delete(node.id);
        }
        render(currentTree);
    };

    /* Every row in the tree that has anything under it to fold. */
    const foldable = (nodes, into = []) => {
        for (const node of nodes) {
            if (!node.children.length) {
                continue;
            }
            into.push(node.id);
            foldable(node.children, into);
        }
        return into;
    };

    const chevron = (node, open) => {
        const element = label('tree-chevron', node.children.length ? (open ? '▾' : '▸') : '');
        if (!node.children.length) {
            return element;
        }

        element.classList.add('foldable');
        element.addEventListener('click', event => {
            event.stopPropagation();
            toggle(node, open);
        });
        return element;
    };

    let currentTree = [];
    return {
        render(tree) {
            currentTree = tree;
            render(tree);
        },

        /* The whole tree at once, for a reader who wants all of it or none. */
        expandAll() {
            collapsed.clear();
            render(currentTree);
        },

        collapseAll() {
            for (const id of foldable(currentTree)) {
                collapsed.add(id);
            }
            render(currentTree);
        },

        /* Whether either of those has anything left to do. */
        get folds() {
            const ids = foldable(currentTree);
            return {
                canExpand: ids.some(id => collapsed.has(id)),
                canCollapse: ids.some(id => !collapsed.has(id)),
            };
        },
    };
}

function label(className, text) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
}
