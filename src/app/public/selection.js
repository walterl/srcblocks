/*
 * What the canvas has selected, from three sources with different lifetimes:
 * the pointer (transient), the trail (where clicking a node starts a fresh one
 * and following a call extends it), and the pins (any number, until
 * unpinned).
 *
 * The trail is what makes the calls window a breadcrumb: following a call keeps
 * the function it was followed from in the list, so its other calls stay one
 * click away.
 *
 * Everything is listed most recent first, with whatever the pointer is on at
 * the very top.
 */
export function createSelection() {
    let hovered = null;
    let trail = [];
    let order = [];
    const pinned = new Set();

    const forget = id => {
        order = order.filter(existing => existing !== id);
    };
    const remember = id => {
        forget(id);
        order.push(id);
    };
    const persistent = id => trail.includes(id) || pinned.has(id);

    return {
        get hovered() {
            return hovered;
        },

        /* The head of the trail: where the canvas last took the reader. */
        get clicked() {
            return trail[trail.length - 1] ?? null;
        },

        get trail() {
            return [...trail];
        },

        hover(id) {
            hovered = id;
        },

        /* Clicking a node starts a fresh trail; clicking nothing ends it. */
        click(id) {
            for (const previous of trail) {
                if (previous !== id && !pinned.has(previous)) {
                    forget(previous);
                }
            }
            trail = id ? [id] : [];
            if (id) {
                remember(id);
            }
        },

        /* Following a call extends the trail rather than replacing it. */
        follow(id) {
            trail = [...trail.filter(existing => existing !== id), id];
            remember(id);
        },

        setPinned(id, isPinned) {
            if (isPinned) {
                pinned.add(id);
                remember(id);
            } else {
                pinned.delete(id);
                if (!trail.includes(id)) {
                    forget(id);
                }
            }
        },

        /* Drops a node from every source - what the calls window's ✕ does. */
        remove(id) {
            if (hovered === id) {
                hovered = null;
            }
            trail = trail.filter(existing => existing !== id);
            pinned.delete(id);
            forget(id);
        },

        /* Clears everything, reporting what was pinned so the pins can follow. */
        clear() {
            const wasPinned = [...pinned];
            hovered = null;
            trail = [];
            pinned.clear();
            order = [];
            return wasPinned;
        },

        isPinned: id => pinned.has(id),

        /* Every selected node, for highlighting their edges. */
        ids: () => new Set([hovered, ...trail, ...pinned].filter(Boolean)),

        /* Selected nodes, most recent first, the hovered one leading. */
        list() {
            const listed = [];
            const push = id => {
                if (id && !listed.includes(id)) {
                    listed.push(id);
                }
            };
            push(hovered);
            for (let index = order.length - 1; index >= 0; index -= 1) {
                if (persistent(order[index])) {
                    push(order[index]);
                }
            }
            return listed;
        },
    };
}
