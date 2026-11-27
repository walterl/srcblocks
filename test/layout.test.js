import { createLayout } from '../src/app/public/layout.js';

const node = (id, kind, parent = null) => ({ id, kind, parent, name: id });
const drawn = (id, kind, parent, { container = false, expanded = false, depth = 0 } = {}) => ({
    node: node(id, kind, parent),
    container,
    expanded,
    depth,
});

const layoutOf = (drawnItems, sizes, layout = createLayout()) =>
    layout.run({ drawn: drawnItems, edges: [] }, id => sizes[id] || { width: 160, height: 32 });

describe('layoutPlan', () => {
    it('stacks what a file holds in the order it is written', () => {
        const layout = layoutOf(
            [
                drawn('file:a.js', 'file', null, { container: true, expanded: true }),
                drawn('first', 'function', 'file:a.js'),
                drawn('second', 'function', 'file:a.js'),
                drawn('third', 'function', 'file:a.js'),
            ],
            {
                'file:a.js': { width: 200, height: 32 },
                first: { width: 300, height: 40 },
                second: { width: 200, height: 60 },
                third: { width: 250, height: 40 },
            },
        );

        const [first, second, third] = ['first', 'second', 'third'].map(id => layout.positions.get(id));
        expect(first.x).toBe(second.x);
        expect(second.x).toBe(third.x);
        expect(second.y).toBeGreaterThan(first.y + first.height);
        expect(third.y).toBeGreaterThan(second.y + second.height);
    });

    it('sizes a file to its contents and its padding, never narrower than its header', () => {
        const layout = layoutOf(
            [
                drawn('file:a.js', 'file', null, { container: true, expanded: true }),
                drawn('only', 'function', 'file:a.js'),
            ],
            { 'file:a.js': { width: 900, height: 32 }, only: { width: 200, height: 100 } },
        );

        const file = layout.positions.get('file:a.js');
        const only = layout.positions.get('only');
        expect(file.width).toBe(900);
        expect(file.height).toBe(100 + 34 + 16);
        expect(only.x).toBe(file.x + 16);
        expect(only.y).toBe(file.y + 34);
    });

    it('packs a module into columns instead of one long line', () => {
        const sizes = { 'module:src': { width: 100, height: 32 } };
        const items = [drawn('module:src', 'module', null, { container: true, expanded: true })];
        for (let index = 0; index < 6; index += 1) {
            items.push(drawn(`file${index}`, 'file', 'module:src'));
            sizes[`file${index}`] = { width: 200, height: 300 };
        }
        const layout = layoutOf(items, sizes);
        const boxes = [...Array(6)].map((_, index) => layout.positions.get(`file${index}`));

        expect(new Set(boxes.map(box => box.x)).size).toBeGreaterThan(1);
        expect(new Set(boxes.map(box => box.y)).size).toBeGreaterThan(1);
        const module = layout.positions.get('module:src');
        expect(module.width / module.height).toBeGreaterThan(0.5);
        expect(module.width / module.height).toBeLessThan(3);
    });

    it('puts the tallest of a module first and keeps equals in order', () => {
        const items = [
            drawn('module:src', 'module', null, { container: true, expanded: true }),
            drawn('short-a', 'file', 'module:src'),
            drawn('tall', 'file', 'module:src'),
            drawn('short-b', 'file', 'module:src'),
        ];
        const layout = layoutOf(items, {
            'module:src': { width: 100, height: 32 },
            'short-a': { width: 100, height: 40 },
            tall: { width: 100, height: 400 },
            'short-b': { width: 100, height: 40 },
        });

        const before = (a, b) => a.x < b.x || (a.x === b.x && a.y < b.y);
        const tall = layout.positions.get('tall');
        const shortA = layout.positions.get('short-a');
        const shortB = layout.positions.get('short-b');

        expect(before(tall, shortA)).toBe(true);
        expect(before(shortA, shortB)).toBe(true);
    });

    it('leaves nothing overlapping', () => {
        const items = [drawn('module:src', 'module', null, { container: true, expanded: true })];
        const sizes = { 'module:src': { width: 100, height: 32 } };
        for (let index = 0; index < 12; index += 1) {
            items.push(drawn(`box${index}`, 'file', 'module:src'));
            sizes[`box${index}`] = { width: 100 + index * 37, height: 40 + (index % 4) * 120 };
        }
        const layout = layoutOf(items, sizes);
        const boxes = [...Array(12)].map((_, index) => layout.positions.get(`box${index}`));

        for (let a = 0; a < boxes.length; a += 1) {
            for (let b = a + 1; b < boxes.length; b += 1) {
                const overlap =
                    boxes[a].x < boxes[b].x + boxes[b].width &&
                    boxes[b].x < boxes[a].x + boxes[a].width &&
                    boxes[a].y < boxes[b].y + boxes[b].height &&
                    boxes[b].y < boxes[a].y + boxes[a].height;
                expect(overlap).toBe(false);
            }
        }
    });

    it('nests a file inside a module inside the canvas', () => {
        const layout = layoutOf(
            [
                drawn('module:src', 'module', null, { container: true, expanded: true }),
                drawn('file:src/a.js', 'file', 'module:src', { container: true, expanded: true, depth: 1 }),
                drawn('fn', 'function', 'file:src/a.js', { depth: 2 }),
            ],
            {
                'module:src': { width: 100, height: 32 },
                'file:src/a.js': { width: 100, height: 32 },
                fn: { width: 220, height: 48 },
            },
        );

        const module = layout.positions.get('module:src');
        const file = layout.positions.get('file:src/a.js');
        const fn = layout.positions.get('fn');
        const inside = (child, parent) =>
            child.x >= parent.x &&
            child.y >= parent.y &&
            child.x + child.width <= parent.x + parent.width &&
            child.y + child.height <= parent.y + parent.height;

        expect(inside(file, module)).toBe(true);
        expect(inside(fn, file)).toBe(true);
        expect(layout.width).toBeGreaterThanOrEqual(module.x + module.width);
    });
});

describe('layout stability', () => {
    const items = [drawn('module:src', 'module', null, { container: true, expanded: true })];
    const sizes = { 'module:src': { width: 100, height: 32 } };
    for (let index = 0; index < 8; index += 1) {
        items.push(drawn(`file${index}`, 'file', 'module:src'));
        sizes[`file${index}`] = { width: 200, height: 200 };
    }

    it('keeps every arrangement when only a size changes', () => {
        const layout = createLayout();
        const before = layoutOf(items, sizes, layout);
        const columnOf = (result, id) => result.positions.get(id).x;
        const columnsBefore = Object.fromEntries(
            items.slice(1).map(item => [item.node.id, columnOf(before, item.node.id)]),
        );

        // file3 opens something: it is now ten times as tall.
        const after = layoutOf(items, { ...sizes, file3: { width: 200, height: 2000 } }, layout);

        for (const [id, x] of Object.entries(columnsBefore)) {
            if (id === 'file3') {
                continue;
            }
            const sameColumn = columnOf(after, id) === x;
            const shiftedWithinColumn = after.positions.get(id).y !== before.positions.get(id).y;
            expect(sameColumn || shiftedWithinColumn).toBe(true);
        }
        // Nothing that shared no column with the grown node moved sideways.
        const grown = before.positions.get('file3');
        const untouched = items
            .slice(1)
            .map(item => item.node.id)
            .filter(id => before.positions.get(id).x !== grown.x);
        for (const id of untouched) {
            expect(after.positions.get(id).x).toBe(before.positions.get(id).x);
            expect(after.positions.get(id).y).toBe(before.positions.get(id).y);
        }
    });

    it('works the arrangement out again when the contents change', () => {
        const layout = createLayout();
        layoutOf(items, sizes, layout);
        const withOneMore = [...items, drawn('extra', 'file', 'module:src')];
        const after = layoutOf(withOneMore, { ...sizes, extra: { width: 200, height: 200 } }, layout);

        expect(after.positions.has('extra')).toBe(true);
    });

    it('forgets arrangements when the graph is replaced', () => {
        const layout = createLayout();
        const before = layoutOf(items, sizes, layout);
        layout.reset();
        const after = layoutOf(items, { ...sizes, file0: { width: 200, height: 900 } }, layout);

        expect(after.positions.get('file0')).not.toEqual(before.positions.get('file0'));
    });
});
