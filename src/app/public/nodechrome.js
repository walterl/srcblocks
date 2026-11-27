import { element, glyph } from './dom.js';
import { displayName } from './model.js';
import { sourceState } from './sourceview.js';

/*
 * The parts of a node that are drawn wherever the node is: on the canvas, and
 * in the windows that give it the whole screen.
 *
 * A node's header carries what the branch did to it in lines, and what can be
 * done to it. On the canvas the latter is a menu the header opens, because the
 * row is too narrow to hold it; a window has room for both at once. Either way
 * they are the same buttons, saying the same things about the same node.
 */

/*
 * How many lines the branch added and removed here, the way a diff reports it.
 * A container carries the total of everything it holds, so a folded file still
 * says how much of it moved.
 */
export function nodeDiffStat({ added, removed }) {
    const stat = element('span', 'node-diffstat');
    stat.title = `${added} added, ${removed} removed`;
    if (added) {
        stat.append(element('span', 'diffstat-added', `+${added}`));
    }
    if (removed) {
        stat.append(element('span', 'diffstat-removed', `−${removed}`));
    }
    return stat;
}

/*
 * Everything on offer for one node, in the order a header holds it.
 * `interactions` is what each button does; see app.js for the one set of them.
 */
export function nodeActions(node, ui, interactions) {
    const { hidden, diffed, status } = sourceState(node, ui);

    // An external is a package name, not code: there is no source to diff, no
    // file to open and no location to copy. It can be taken off the canvas and
    // it can be pinned, and that is all.
    if (node.kind === 'external') {
        return [hideButton(node, hidden, interactions), pin(node, ui, interactions)];
    }

    const buttons = [];

    // What the branch did to this one, in the format a diff is read in. Some
    // changes leave no mark on the canvas - a rewritten comment, a signature
    // that reads the same - and this is where they show up.
    if (ui.hasDiff && status) {
        buttons.push(diffButton(node, interactions));
    }
    if (diffed) {
        buttons.push(nodeDiffViewToggle(ui.sideBySide.has(node.id), () => interactions.onToggleDiffView(node)));
    }
    if (node.file) {
        buttons.push(maximiseButton(node, interactions));
    }
    buttons.push(copyButton(node, interactions));
    if (node.kind === 'module' || node.kind === 'file') {
        buttons.push(exportsButton(node, ui, interactions));
    }
    buttons.push(hideButton(node, hidden, interactions), pin(node, ui, interactions));
    return buttons;
}

/* Every button in the menu acts on release and never on the canvas. */
function action(button, run) {
    button.type = 'button';
    button.addEventListener('mousedown', event => event.stopPropagation());
    button.addEventListener('click', event => {
        event.stopPropagation();
        run();
    });
    return button;
}

const labelButton = (className, text, title, run) => {
    const button = element('button', className, text);
    button.title = title;
    return action(button, run);
};

const iconButton = (className, icon, title, run) => {
    const button = element('button', className);
    button.title = title;
    button.append(glyph(icon));
    return action(button, run);
};

const diffButton = (node, interactions) =>
    labelButton('node-diff', 'diff', `Show the diff for ${node.name}`, () => interactions.onShowDiff(node));

/*
 * Switches a diff between one column and two. This one is not about the node so
 * much as about the source on screen beside it, so the window that gives a node
 * the whole screen keeps it while wanting none of the rest.
 */
export function nodeDiffViewToggle(split, onToggle) {
    return labelButton(
        'node-diff-view',
        split ? 'inline' : 'split',
        split ? 'Show the diff in one column' : 'Show the diff side by side',
        onToggle,
    );
}

/*
 * Opens this node in a window the size of the canvas: the file it lives in,
 * read at its own lines. A module is a directory rather than anything with a
 * file behind it, so there is nothing for it to open - its `diff` button is
 * what it has instead.
 */
const maximiseButton = (node, interactions) =>
    labelButton('node-maximise', '⤢', `Open ${displayName(node)} in a window`, () => interactions.onMaximise(node));

/*
 * Copies where this node is, in the form an editor takes: the reader is reading
 * here and editing somewhere else, and this is the shortest way from one to the
 * other.
 */
function copyButton(node, interactions) {
    const button = iconButton('node-copy', 'copy', 'Copy this location for :edit', () =>
        interactions.onCopyLocation(node, button),
    );
    return button;
}

/*
 * Takes a node out of the picture, or brings it back: what is hidden stays on
 * the canvas, faint and shut, and nothing else counts it.
 */
function hideButton(node, hidden, interactions) {
    const button = iconButton(
        'node-hide',
        hidden ? 'show' : 'hide',
        hidden ? `Bring ${displayName(node)} back` : `Take ${displayName(node)} off the canvas`,
        () => interactions.onHideChange(node, !hidden),
    );
    button.setAttribute('aria-pressed', String(hidden));
    return button;
}

/*
 * Narrows a module or file down to what it exports - its public interface - or
 * opens it back up. A class has no such button: its members are not exported
 * one by one, so there is nothing in it to narrow down.
 */
function exportsButton(node, ui, interactions) {
    const only = ui.exportsOnlyAt(node.id);
    const button = iconButton(
        'node-exports',
        'export',
        only ? `Show everything in ${displayName(node)}` : `Show only what ${displayName(node)} exports`,
        () => interactions.onExportsOnlyChange(node),
    );
    button.setAttribute('aria-pressed', String(only));
    return button;
}

/* Keeps this node's calls highlighted whatever else is selected, or lets them go. */
function pin(node, ui, interactions) {
    const pinned = ui.isPinned(node.id);
    const button = iconButton(
        'node-pin',
        'pin',
        pinned ? 'Unpin: stop highlighting this node’s calls' : 'Pin selection: keep this node’s calls highlighted',
        () => interactions.onPinChange(node, !pinned),
    );
    button.setAttribute('aria-pressed', String(pinned));
    return button;
}
