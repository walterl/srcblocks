import { ancestors } from './model.js';

/*
 * Ctrl-click on a name to go to where it is defined.
 *
 * Holding ctrl marks the page, and the name under the pointer shows as a link
 * if it has a definition in the tree; the names that do were wrapped when the
 * source was drawn. The key can go down while the page does not have focus, so
 * the pointer's own reading of it is believed too.
 *
 * A definition is a node - a function, a class, a constant - or a line inside
 * one, or, where no node holds it, a line of its file. Whatever keeps it off the
 * canvas gives way: a hidden node and everything holding it is brought back, and
 * a canvas filtered down to the branch's changes keeps it all the same.
 */
export function createDefinitions({ state, root, navigateTo, showFile, reportError }) {
    const hold = held => document.body.classList.toggle('ctrl-held', held);

    window.addEventListener('keydown', event => {
        if (event.key === 'Control') {
            hold(true);
        }
    });
    window.addEventListener('keyup', event => {
        if (event.key === 'Control') {
            hold(false);
        }
    });
    window.addEventListener('blur', () => hold(false));
    root.addEventListener('mousemove', event => hold(event.ctrlKey), { passive: true });

    // Caught on the way down, before the node or the canvas takes the click.
    root.addEventListener(
        'click',
        event => {
            const link = event.ctrlKey && event.target.closest?.('.code-ref');
            if (!link) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            follow(
                link.dataset.target,
                Number(link.dataset.line) || null,
                link.closest('.node')?.dataset.id || null,
            ).catch(reportError);
        },
        true,
    );

    async function follow(id, line, from) {
        const target = state.index?.nodes.get(id);
        if (!target) {
            return;
        }
        if (target.kind === 'file') {
            await showFile(target, { line });
            return;
        }
        reveal(id);
        await navigateTo(id, from, { line });
    }

    function reveal(id) {
        for (const shown of [id, ...ancestors(state.index, id)]) {
            state.hidden.delete(shown);
        }
        state.revealed.add(id);
    }
}
