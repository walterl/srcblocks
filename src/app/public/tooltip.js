/*
 * The hover tooltip for a module, file or class: where it lives, what it holds,
 * and what the branch did inside it.
 */
const EDGE_GAP = 16;

export function createTooltip(root) {
    let timer = null;

    const place = point => {
        const { width, height } = root.getBoundingClientRect();
        const view = root.parentElement.getBoundingClientRect();
        const left = Math.min(point.x - view.left + 14, view.width - width - EDGE_GAP);
        const top = Math.min(point.y - view.top + 18, view.height - height - EDGE_GAP);
        root.style.left = `${Math.max(EDGE_GAP, left)}px`;
        root.style.top = `${Math.max(EDGE_GAP, top)}px`;
    };

    return {
        /* Shown after a pause, so it does not chase the pointer across the canvas. */
        schedule(build, point, delay = 250) {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const content = build();
                if (!content) {
                    return;
                }
                root.replaceChildren(content);
                root.removeAttribute('hidden');
                place(point);
            }, delay);
        },

        hide() {
            clearTimeout(timer);
            root.setAttribute('hidden', '');
        },
    };
}

const line = (className, text) => {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    return element;
};

const CHANGE_LABELS = { added: 'new', changed: 'changed', removed: 'removed' };

/* Builds the tooltip's contents from a container description. */
export function describeToTooltip({ kind, path, counts, changes }, countsText) {
    const content = document.createDocumentFragment();
    content.append(line('tooltip-path', path), line('tooltip-kind', kind));
    if (countsText) {
        content.append(line('tooltip-counts', countsText));
    }

    const changed = Object.entries(changes).filter(([, total]) => total > 0);
    if (changed.length) {
        const row = document.createElement('div');
        row.className = 'tooltip-changes';
        for (const [status, total] of changed) {
            row.append(line(`tooltip-change status-${status}`, `${total} ${CHANGE_LABELS[status]}`));
        }
        content.append(row);
    }
    return content;
}
