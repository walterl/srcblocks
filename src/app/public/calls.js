import { declarationKind, displayName } from './model.js';

/*
 * The floating list of what the selection calls and what calls it, one group
 * per selected node: the newest selection on top and open, the ones selected
 * before it collapsed underneath. A group's header jumps back to that node, its
 * ✕ deselects it, and clicking any call jumps to the function at the other end
 * of it.
 *
 * A group is a function or a container - a module, a file, a class - and a
 * container answers for everything inside it, so its two lists are every call
 * its contents make and every call that reaches into them.
 */
export function createCallsWindow({ root, title, groups, dock, close, handlers }) {
    root.addEventListener('mouseenter', handlers.onPointerIn);
    root.addEventListener('mouseleave', handlers.onPointerOut);
    // Hiding the window on its own would last until the next hover; closing it
    // means dropping the selection it is listing.
    close.addEventListener('click', handlers.onClose);

    /*
     * Docked, the list is a sidebar down the right of the canvas rather than a
     * panel floating over it: the canvas gives up the width instead of being
     * covered, which is what makes a long list of calls readable beside the
     * nodes it is about. The class on the body is what moves the canvas over,
     * so it only holds while the list is actually up.
     */
    let docked = false;

    const applyDock = () => {
        root.classList.toggle('docked', docked);
        document.body.classList.toggle('calls-docked', docked && !root.hasAttribute('hidden'));
        dock.setAttribute('aria-pressed', String(docked));
        dock.title = docked ? 'Float over the canvas' : 'Dock to the right';
    };

    dock.addEventListener('click', () => {
        docked = !docked;
        applyDock();
    });

    /*
     * Folding a branch redraws the list where it stands rather than asking the
     * canvas for it again: nothing about the graph or the selection changed, so
     * the place the reader had scrolled to should not move either.
     */
    let shown = null;
    const refold = () => {
        const scrolled = groups.scrollTop;
        draw(shown);
        groups.scrollTop = scrolled;
    };

    const draw = selected => {
        shown = selected;
        title.textContent = selected.length > 1 ? `Calls · ${selected.length} selected` : 'Calls';
        groups.replaceChildren(...selected.map(group => buildGroup(group, { ...handlers, onFold: refold })));
        explainTruncated(groups);
    };

    return {
        hide() {
            root.setAttribute('hidden', '');
            applyDock();
        },

        show(selected) {
            root.removeAttribute('hidden');
            draw(selected);
            applyDock();
        },
    };
}

/*
 * Which branches of which list are open, by the node they hang under. Folding
 * is remembered here rather than in the canvas's state because it is about
 * reading this list, not about the graph: it outlives every redraw of the panel
 * and nothing else has anything to ask of it.
 *
 * A branch nobody has touched is open or folded by the rule below; a branch the
 * reader has folded or opened stays the way they left it.
 */
const unfolded = new Map();

const foldKey = (context, branch) => `${context.key}|${branch.id}`;
const isOpen = (context, branch) =>
    unfolded.has(foldKey(context, branch)) ? unfolded.get(foldKey(context, branch)) : context.openByDefault;

/* Every branch below one, at any depth. A pseudo-branch of `{ children }` asks
   about a whole list. */
const under = branch => branch.children.flatMap(child => [child, ...under(child)]);

const openAllUnder = (context, branch, open) => {
    for (const child of under(branch)) {
        unfolded.set(foldKey(context, child), open);
    }
};

/*
 * Whether there is anything left to open below a branch. This is what the
 * expand-all button says: it offers to open what is closed, and once nothing is
 * closed it offers to put it all away again.
 */
const allOpenUnder = (context, branch) => under(branch).every(child => isOpen(context, child));

/*
 * A list short enough to take in at a glance arrives open. A longer one arrives
 * as the modules, files and classes its calls land in, each with its count, and
 * the reader opens the part they came for - which is the only way five hundred
 * calls are navigable at all.
 */
const FOLD_ABOVE = 30;

/*
 * A name or a path the window had to cut short gets a tooltip carrying the whole
 * of it; one that fits does not, since a tooltip repeating what is on screen is
 * only in the way.
 */
function explainTruncated(root) {
    const cut = '.calls-entry-name, .calls-entry-where, .calls-group-fn, .calls-group-where, .calls-branch-name';
    for (const element of root.querySelectorAll(cut)) {
        if (element.scrollWidth > element.clientWidth + 1) {
            element.title = element.textContent;
        } else {
            element.removeAttribute('title');
        }
    }
}

/* The two ends of a group, and what each says when it holds nothing. */
const SECTIONS = [
    { label: 'calls', of: group => group.calls, empty: 'Calls nothing in this tree.' },
    { label: 'called by', of: group => group.callers, empty: 'Nothing in this tree calls it.' },
];

/* Everything the fold state needs to know about one of those lists. */
const sectionContext = (node, label, listed, handlers) => ({
    key: `${node.id}|${label}`,
    source: node,
    handlers,
    openByDefault: listed.total <= FOLD_ABOVE,
});

function buildGroup(group, handlers) {
    const { node, open } = group;
    const element = document.createElement('section');
    element.className = `calls-group${open ? ' open' : ''}`;
    element.dataset.id = node.id;
    element.append(buildGroupHeader(group, handlers));

    if (open) {
        element.append(...SECTIONS.map(section => buildSection(section, group, handlers)));
    }
    return element;
}

function buildSection({ label, of, empty }, group, handlers) {
    const listed = of(group);
    const section = document.createElement('div');
    section.className = 'calls-section';
    section.append(labelled('calls-section-label', `${label} · ${listed.total}`));

    const context = sectionContext(group.node, label, listed, handlers);

    const list = document.createElement('ul');
    list.className = 'calls-entries';
    list.replaceChildren(...(listed.total ? rowsFor(listed.branches, listed.calls, context, 0) : [emptyEntry(empty)]));
    section.append(list);
    return section;
}

/*
 * Opens or folds a whole subtree in one click: reaching one call down four
 * levels of module is four clicks, and putting a list of five hundred away
 * again is worse. Which of the two it offers is whichever the subtree is not
 * already, and it takes the branch it belongs to with it - so one click opens
 * everything and the next puts it all back, however deep, and a file or a class
 * holding nothing but calls answers the same way as the modules above it.
 *
 * `lists` is the branch's own list, or both of a group's - a group's lists have
 * no row of their own to fold, and stay as they are.
 */
function deepFold(lists, handlers) {
    const expanded = lists.every(({ context, branch, open }) => open && allOpenUnder(context, branch));

    const control = button('calls-deep-fold', '', event => {
        // The row behind it is a button of its own, and folding the subtree is
        // not the same act as folding this one level.
        event.stopPropagation();
        for (const { context, branch } of lists) {
            openAllUnder(context, branch, !expanded);
            if (branch.id) {
                unfolded.set(foldKey(context, branch), !expanded);
            }
        }
        handlers.onFold();
    });
    control.title = expanded ? 'Fold everything under this' : 'Open everything under this';
    control.append(glyph(expanded ? '#icon-collapse' : '#icon-expand'));
    return control;
}

/* A group's button needs a branch somewhere in its lists to act on. */
const hasBranches = lists => lists.some(({ branch }) => branch.children.length > 0);

function glyph(href) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon-glyph');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', href);
    svg.append(use);
    return svg;
}

/* A level of the tree: the containers at it, then the calls hanging off it. */
const rowsFor = (branches, calls, context, depth) => [
    ...branches.map(branch => buildBranch(branch, context, depth)),
    ...calls.map(call => entry({ ...call, source: context.source }, context.handlers, depth)),
];

/*
 * One container, and what of the list is under it. A branch that is folded
 * still says how much: a count is what tells the reader whether to open it.
 */
function buildBranch(branch, context, depth) {
    const item = document.createElement('li');
    item.className = 'calls-branch';

    const open = isOpen(context, branch);
    const row = button(`calls-branch-row${open ? ' open' : ''}`, '', () => {
        unfolded.set(foldKey(context, branch), !open);
        context.handlers.onFold();
    });
    row.style.paddingLeft = `${depth * 10 + 4}px`;
    row.title = open ? 'Fold this away' : `Open ${branch.count} of them`;
    row.append(
        labelled('calls-branch-chevron', open ? '▾' : '▸'),
        labelled('calls-branch-kind', declarationKind(branch.node)),
        labelled('calls-branch-name', branch.name),
        labelled('calls-branch-count', String(branch.count)),
    );

    // The row and the button beside it are two controls, so they are two
    // buttons - one cannot sit inside the other.
    const head = document.createElement('div');
    head.className = 'calls-branch-head';
    head.append(row);
    head.append(deepFold([{ context, branch, open }], context.handlers));
    item.append(head);

    if (open) {
        const nested = document.createElement('ul');
        nested.className = 'calls-entries nested';
        nested.replaceChildren(...rowsFor(branch.children, branch.calls, context, depth + 1));
        item.append(nested);
    }
    return item;
}

/* Where a group's node lives: a module is a directory, and has no line. */
const where = node => (node.kind === 'module' ? node.path : `${node.file}${node.line ? `:${node.line}` : ''}`);

/*
 * The line under a group's name. A module is named by its own directory, so
 * repeating it says nothing: what places it is the directory above, and the
 * outermost module has none.
 */
const whereLabel = node => (node.kind === 'module' ? node.path.split('/').slice(0, -1).join('/') : node.file);

/* A method is written with the dot that calling it needs. */
const callLabel = (node, method) => `${method ? '.' : ''}${displayName(node)}`;

function buildGroupHeader(group, handlers) {
    const { node, calls, callers, open, status, method } = group;
    const header = document.createElement('header');
    header.className = 'calls-group-header';

    const toggle = button('calls-group-toggle', open ? '▾' : '▸', () => handlers.onToggleGroup(node.id));
    toggle.title = open ? 'Collapse' : 'Expand';

    const name = button('calls-group-name', '', () => handlers.onJump(node.id, node.id));
    name.title = `Jump to ${where(node)}`;
    if (node.role) {
        name.append(labelled(`calls-entry-role role-${node.role}`, node.role));
    }
    name.append(labelled(statusClass('calls-group-fn', status), callLabel(node, method)));
    const place = whereLabel(node);
    if (place) {
        name.append(labelled('calls-group-where', place));
    }

    const count = labelled('calls-group-count', `${calls.total}↓ ${callers.total}↑`);
    count.title = `calls ${calls.total}, called by ${callers.total}`;

    const remove = button('calls-group-remove', '✕', () => handlers.onRemove(node.id));
    remove.title = 'Deselect this';

    header.append(toggle, name, count);
    // Only while the group is open: with its lists put away there is nothing
    // below to open, and the chevron is the control that says so.
    const lists = SECTIONS.map(section => ({
        context: sectionContext(node, section.label, section.of(group), handlers),
        branch: { children: section.of(group).branches },
        open: true,
    }));
    if (open && hasBranches(lists)) {
        header.append(deepFold(lists, handlers));
    }
    header.append(remove);
    return header;
}

const ACCESS_LABEL = { read: 'reads', write: 'writes', both: 'reads · writes' };

/* `call.source` is the group the entry sits in - where a jump comes from. */
function entry(call, handlers, depth = 0) {
    const item = document.createElement('li');
    // The row is a diff line: green where the branch added the call, red where
    // it took it away. The name says what happened to the function itself.
    const target = button(
        ['calls-entry', call.status ? `call-${call.status}` : '', call.node.role ? 'is-test' : '']
            .filter(Boolean)
            .join(' '),
        '',
        () => handlers.onJump(call.node.id, call.source.id),
    );

    if (call.status) {
        const marker = labelled(`calls-entry-call call-${call.status}`, call.status === 'removed' ? '−' : '+');
        marker.title = call.status === 'removed' ? 'call removed on this branch' : 'call added on this branch';
        target.append(marker);
    }
    // A test reaching into the code is a different kind of link from one piece
    // of code calling another, and worth telling apart at a glance.
    if (call.node.role) {
        target.append(labelled(`calls-entry-role role-${call.node.role}`, call.node.role));
    }
    // Reaching a constant is listed as a call, because it is a dependency to
    // follow, but the row says which of the two it is.
    if (call.access) {
        target.append(labelled('calls-entry-access', ACCESS_LABEL[call.access]));
    }
    target.append(
        labelled(statusClass('calls-entry-name', call.nodeStatus), callLabel(call.node, call.method)),
        labelled('calls-entry-where', `${call.node.file}:${call.node.line}`),
    );
    if (call.callCount > 1) {
        target.append(labelled('calls-entry-count', `×${call.callCount}`));
    }
    if (call.recursive) {
        target.append(labelled('calls-entry-count', 'recursive'));
    }

    target.style.paddingLeft = `${depth * 10 + 6}px`;
    item.append(target);
    return item;
}

function emptyEntry(text) {
    const item = document.createElement('li');
    item.className = 'calls-empty';
    item.textContent = text;
    return item;
}

function button(className, text, onClick) {
    const created = document.createElement('button');
    created.type = 'button';
    created.className = className;
    if (text) {
        created.textContent = text;
    }
    created.addEventListener('click', onClick);
    return created;
}

/* Function names carry what the branch did to the function itself. */
const statusClass = (className, status) => (status ? `${className} status-${status}` : className);

function labelled(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
}
