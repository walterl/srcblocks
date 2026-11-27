/*
 * Which commit wrote each line, per file revision.
 *
 * Blame is a round trip and drawing is not, so a view asks for what has already
 * arrived and gets nothing on the first ask; the answer triggers a redraw. Two
 * views of the same revision share one request, and one answer.
 */
export function createBlame({ fetch, onLoaded }) {
    const cache = new Map();
    const inflight = new Map();

    const keyOf = (path, ref) => `${ref} ${path}`;

    function request(path, ref) {
        const key = keyOf(path, ref);
        if (inflight.has(key)) {
            return inflight.get(key);
        }

        const pending = fetch(path, ref)
            .catch(() => EMPTY)
            .then(blame => {
                cache.set(key, blame);
                inflight.delete(key);
                return blame;
            });
        inflight.set(key, pending);
        return pending;
    }

    return {
        /* What is known now. Asking starts the fetch that answers next time. */
        of(path, ref) {
            if (!path || !ref) {
                return null;
            }
            const key = keyOf(path, ref);
            if (cache.has(key)) {
                return cache.get(key);
            }
            request(path, ref).then(onLoaded);
            return null;
        },

        /* For windows that are built once: wait, then draw with the answer. */
        async load(wanted) {
            await Promise.all(wanted.map(({ path, ref }) => (path && ref ? request(path, ref) : null)));
        },
    };
}

const EMPTY = { lines: {}, commits: {} };

/* One side's blame, and the line that side starts at, for the rows below. */
export const blameSide = (from, map) => (map && from !== null && from !== undefined ? { from, ...map } : null);

/*
 * The commit behind each row of a diff.
 *
 * A new line is answered by the revision that wrote it and a removed line by
 * the one before, where it still exists - so both sides are counted, whichever
 * side the rows are numbered by. A row nobody can answer for gets null.
 */
export function blameRows(rows, blame) {
    const at = { added: blame?.added?.from ?? null, removed: blame?.removed?.from ?? null };

    return rows.map(row => {
        const type = row.type === 'context' ? null : row.type;
        const side = type ? blame?.[type] : null;
        const sha = side && at[type] !== null ? side.lines[at[type]] : null;

        if (row.type !== 'removed' && at.added !== null) {
            at.added += 1;
        }
        if (row.type !== 'added' && at.removed !== null) {
            at.removed += 1;
        }
        return sha ? { sha, commit: side.commits[sha] || null } : null;
    });
}
