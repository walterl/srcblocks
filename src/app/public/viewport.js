/*
 * How far out the canvas can be taken. A node zoomed past this is a speck: its
 * header is nine pixels tall, which is enough to read the shape of the tree and
 * nothing else. Framing everything stops here too, so a fully expanded tree is
 * framed around its middle at a scale worth looking at rather than fitted whole
 * as a grey mist - the way back to the whole shape is to collapse it, not to
 * shrink it out of sight.
 */
const MIN_SCALE = 0.35;
const PAN_THRESHOLD = 4;
// How much of a turn of the wheel becomes zoom. Gentle enough that a scroll
// lands where it was aimed rather than overshooting.
const ZOOM_RATE = 0.0007;
const FLIGHT_MIN_MS = 320;
const FLIGHT_MAX_MS = 900;
const MAX_DIP = 0.6;

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const MAX_SCALE = 3;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* Where source is read: on the canvas, maximised, and in a diff. */
const READING = '.node-body, #code-body, #diff-body';

const scrolls = (overflow, room) => (overflow === 'auto' || overflow === 'scroll') && room > 1;

/*
 * What the wheel belongs to, looking outwards from what it landed on. Source
 * under the pointer owns it whether it has anywhere left to scroll or not:
 * reading is what the wheel is for there, and a snippet that has run out of
 * lines should sit still rather than hand the canvas a zoom.
 *
 * Anything else owns the wheel while it can still scroll along either axis - a
 * trackpad rarely sends one axis alone, and a sideways nudge in the middle of a
 * scroll should not zoom the canvas out from under the reader.
 */
function wheelOwner(event, viewport) {
    for (let element = event.target; element && element !== viewport; element = element.parentElement) {
        if (!(element instanceof HTMLElement)) {
            continue;
        }
        if (element.matches(READING)) {
            return element;
        }

        const style = getComputedStyle(element);
        if (scrolls(style.overflowY, element.scrollHeight - element.clientHeight)) {
            return element;
        }
        if (scrolls(style.overflowX, element.scrollWidth - element.clientWidth)) {
            return element;
        }
    }
    return null;
}

/* Pan (drag) and zoom (wheel) for the canvas, applied as a CSS transform. */
export function createViewportControls(viewport, world, { onBackgroundClick = () => {} } = {}) {
    const transform = { x: 40, y: 60, scale: 1 };
    let flight = null;

    const apply = () => {
        world.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
    };

    /* Anything the reader does with the canvas ends a flight in progress. */
    const cancelFlight = () => {
        if (flight === null) {
            return;
        }
        cancelAnimationFrame(flight);
        flight = null;
    };

    /* The world point currently in the middle of the canvas. */
    const middle = () => {
        const rect = viewport.getBoundingClientRect();
        return {
            x: (rect.width / 2 - transform.x) / transform.scale,
            y: (rect.height / 2 - transform.y) / transform.scale,
        };
    };

    /* Puts a world point in the middle of the canvas at the given scale. */
    const focusOn = (point, scale) => {
        const rect = viewport.getBoundingClientRect();
        transform.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
        transform.x = rect.width / 2 - point.x * transform.scale;
        transform.y = rect.height / 2 - point.y * transform.scale;
        apply();
    };

    /*
     * Flies from the middle of the canvas to a world point. The point being
     * interpolated stays in the middle throughout, so the canvas reads as
     * travelling rather than cutting; a long trip dips the zoom out on the way,
     * which is what shows the reader where they went.
     */
    function flyTo(target, toScale) {
        cancelFlight();
        const from = middle();
        const fromScale = transform.scale;
        const rect = viewport.getBoundingClientRect();
        const travel = Math.hypot(target.x - from.x, target.y - from.y) * Math.min(fromScale, toScale);

        if (prefersReducedMotion() || (travel < 4 && Math.abs(toScale - fromScale) < 0.01)) {
            focusOn(target, toScale);
            return Promise.resolve();
        }

        const duration = clamp(FLIGHT_MIN_MS + travel * 0.25, FLIGHT_MIN_MS, FLIGHT_MAX_MS);
        const dip = clamp(1 - rect.width / (travel + 1), 0, MAX_DIP);
        const started = performance.now();

        return new Promise(resolve => {
            const step = now => {
                const t = Math.min(1, (now - started) / duration);
                const eased = easeInOut(t);
                const point = {
                    x: from.x + (target.x - from.x) * eased,
                    y: from.y + (target.y - from.y) * eased,
                };
                const scale = (fromScale + (toScale - fromScale) * eased) * (1 - dip * Math.sin(Math.PI * t));
                focusOn(point, scale);

                if (t < 1) {
                    flight = requestAnimationFrame(step);
                } else {
                    flight = null;
                    resolve();
                }
            };
            flight = requestAnimationFrame(step);
        });
    }

    viewport.addEventListener('mousedown', event => {
        cancelFlight();
        if (event.button !== 0 || event.target.closest('.node-header, .node-body')) {
            return;
        }
        const from = { x: event.clientX, y: event.clientY };
        const start = { x: event.clientX - transform.x, y: event.clientY - transform.y };
        let panned = false;
        viewport.classList.add('panning');

        const onMove = move => {
            if (Math.hypot(move.clientX - from.x, move.clientY - from.y) >= PAN_THRESHOLD) {
                panned = true;
            }
            transform.x = move.clientX - start.x;
            transform.y = move.clientY - start.y;
            apply();
        };
        const onUp = () => {
            viewport.classList.remove('panning');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            // A press that went nowhere was a click on the background - the
            // canvas between the nodes, or inside a container between the
            // functions it holds - and drops what is selected.
            if (!panned) {
                onBackgroundClick();
            }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    viewport.addEventListener(
        'wheel',
        event => {
            // Over a function's source, the wheel belongs to that source: let
            // the browser scroll it instead of zooming the canvas.
            if (wheelOwner(event, viewport)) {
                return;
            }
            event.preventDefault();
            cancelFlight();
            const rect = viewport.getBoundingClientRect();
            const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            const factor = Math.exp(-event.deltaY * ZOOM_RATE);
            const scale = clamp(transform.scale * factor, MIN_SCALE, MAX_SCALE);
            const ratio = scale / transform.scale;

            // Keep the point under the cursor fixed while zooming.
            transform.x = pointer.x - (pointer.x - transform.x) * ratio;
            transform.y = pointer.y - (pointer.y - transform.y) * ratio;
            transform.scale = scale;
            apply();
        },
        { passive: false },
    );

    apply();

    return {
        getScale: () => transform.scale,

        /* Shifts the canvas by a screen-space delta. */
        panBy(dx, dy) {
            cancelFlight();
            transform.x += dx;
            transform.y += dy;
            apply();
        },

        /*
         * Flies an element to the middle of the canvas at a readable scale.
         * Resolves when it lands.
         */
        centerOn(element, minScale = 0.8) {
            const view = viewport.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            const target = {
                x: (box.left + box.width / 2 - view.left - transform.x) / transform.scale,
                y: (box.top + box.height / 2 - view.top - transform.y) / transform.scale,
            };
            return flyTo(target, Math.max(transform.scale, minScale));
        },

        fit(width, height) {
            cancelFlight();
            if (!width || !height) {
                return;
            }
            const rect = viewport.getBoundingClientRect();
            const scale = clamp(Math.min((rect.width - 80) / width, (rect.height - 100) / height), MIN_SCALE, 1);
            transform.scale = scale;
            transform.x = (rect.width - width * scale) / 2;
            transform.y = (rect.height - height * scale) / 2 + 20;
            apply();
        },
    };
}
