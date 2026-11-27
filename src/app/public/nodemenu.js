import { nodeActions } from './nodechrome.js';

/*
 * What can be done to a node, in a menu that opens against its header when the
 * pointer rests there.
 *
 * These buttons used to sit in the header itself, competing for the row that
 * has to carry the node's name, where it lives, and how many lines the branch
 * changed in it. Out here they also draw at the screen's size rather than the
 * canvas's, so they stay legible and clickable however far the canvas is
 * zoomed out.
 */

/* How far the menu keeps from the edge of the canvas. */
const EDGE = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/*
 * The menu is a single element over the canvas, filled in for whichever node
 * the pointer is on. `anchorFor` gives back the on-screen box of a node's
 * header, or nothing once that node is no longer drawn.
 */
export function createNodeMenu({ root, interactions, anchorFor }) {
    let shown = null;
    let openTimer = null;
    let closeTimer = null;

    // A press on the menu is for the menu: the canvas would otherwise read it
    // as the start of a pan.
    root.addEventListener('mousedown', event => event.stopPropagation());

    /*
     * Flush against the header, over the pointer. A node's header is a strip of
     * any width - a folded function is as narrow as its name, an open module is
     * wider than the canvas - so the row itself is what the menu is placed
     * against, and the pointer is what it is placed along.
     *
     * Flush is what makes it reachable. A gap here is canvas, and the canvas
     * above a header usually belongs to the node above it: the pointer setting
     * off for the menu would cross that node, which would claim the hover and
     * take the menu away with it. Touching the header, there is nothing to
     * cross.
     */
    const place = (rect, point) => {
        const view = root.parentElement.getBoundingClientRect();
        const { width, height } = root.getBoundingClientRect();

        const above = rect.top - view.top - height;
        const top = above >= EDGE ? above : rect.bottom - view.top;
        const left = point.x - view.left - width / 2;

        root.style.left = `${clamp(left, EDGE, Math.max(EDGE, view.width - width - EDGE))}px`;
        root.style.top = `${clamp(top, EDGE, Math.max(EDGE, view.height - height - EDGE))}px`;
    };

    /* Draws the menu for the node it is open on, wherever that node now sits. */
    function draw() {
        if (!shown) {
            return;
        }
        const rect = anchorFor(shown.node.id);
        if (!rect) {
            hide();
            return;
        }
        root.replaceChildren(...nodeActions(shown.node, shown.ui, interactions));
        root.removeAttribute('hidden');
        place(rect, shown.point);
    }

    function hide() {
        clearTimeout(openTimer);
        clearTimeout(closeTimer);
        openTimer = null;
        closeTimer = null;
        shown = null;
        root.setAttribute('hidden', '');
    }

    return {
        /*
         * The pointer is on a node's header. Opening waits a moment, so a
         * pointer crossing several headers on its way somewhere does not leave
         * a trail of menus behind it.
         */
        enter(node, ui, point, delay = 110) {
            clearTimeout(closeTimer);
            closeTimer = null;
            if (shown?.node.id === node.id) {
                shown.ui = ui;
                return;
            }
            clearTimeout(openTimer);
            openTimer = setTimeout(() => {
                openTimer = null;
                shown = { node, ui, point };
                draw();
            }, delay);
        },

        /*
         * The pointer is on the menu itself, which keeps it open - and drops
         * any menu waiting to replace it. Arriving over a neighbour on the way
         * here asked for that neighbour's menu, and the pointer has since said
         * where it was actually going.
         */
        keep() {
            clearTimeout(openTimer);
            clearTimeout(closeTimer);
            openTimer = null;
            closeTimer = null;
        },

        /*
         * The pointer has gone elsewhere. Closing is delayed so that it can
         * travel from the header to the menu without the menu vanishing on the
         * way there.
         */
        leave(delay = 220) {
            clearTimeout(openTimer);
            openTimer = null;
            if (!shown || closeTimer) {
                return;
            }
            closeTimer = setTimeout(hide, delay);
        },

        /* Redraws an open menu after the canvas was rebuilt under it. */
        refresh(ui) {
            if (!shown) {
                return;
            }
            shown.ui = ui;
            draw();
        },

        holds: target => root.contains(target),
        hide,
    };
}
