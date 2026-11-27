import { createSelection } from '../src/app/public/selection.js';

describe('createSelection', () => {
    it('lists the hovered node first and the rest most recent first', () => {
        const selection = createSelection();
        selection.click('a');
        selection.setPinned('b', true);
        selection.hover('c');

        expect(selection.list()).toEqual(['c', 'b', 'a']);
    });

    it('keeps one click selection at a time', () => {
        const selection = createSelection();
        selection.click('a');
        selection.click('b');

        expect(selection.list()).toEqual(['b']);
        expect(selection.clicked).toBe('b');
    });

    it('does not drop a pinned node when the click moves on', () => {
        const selection = createSelection();
        selection.setPinned('a', true);
        selection.click('a');
        selection.click('b');

        expect(selection.list()).toEqual(['b', 'a']);
    });

    it('forgets a node once nothing selects it any more', () => {
        const selection = createSelection();
        selection.setPinned('a', true);
        selection.setPinned('a', false);

        expect(selection.list()).toEqual([]);
    });

    it('drops a node from every source at once', () => {
        const selection = createSelection();
        selection.setPinned('a', true);
        selection.click('a');
        selection.hover('a');
        selection.remove('a');

        expect(selection.list()).toEqual([]);
        expect(selection.ids().size).toBe(0);
    });

    it('reports what was pinned when everything is cleared', () => {
        const selection = createSelection();
        selection.setPinned('a', true);
        selection.setPinned('b', true);
        selection.click('c');

        expect(selection.clear().sort()).toEqual(['a', 'b']);
        expect(selection.list()).toEqual([]);
    });

    it('collects every selected node for highlighting', () => {
        const selection = createSelection();
        selection.hover('a');
        selection.click('b');
        selection.setPinned('c', true);

        expect([...selection.ids()].sort()).toEqual(['a', 'b', 'c']);
    });

    it('moves a re-selected node back to the front', () => {
        const selection = createSelection();
        selection.setPinned('a', true);
        selection.setPinned('b', true);
        selection.click('a');

        expect(selection.list()).toEqual(['a', 'b']);
    });
});

describe('createSelection trail', () => {
    it('keeps the function a call was followed from', () => {
        const selection = createSelection();
        selection.click('caller');
        selection.follow('callee');

        expect(selection.list()).toEqual(['callee', 'caller']);
    });

    it('grows the trail as calls are followed', () => {
        const selection = createSelection();
        selection.click('a');
        selection.follow('b');
        selection.follow('c');

        expect(selection.list()).toEqual(['c', 'b', 'a']);
    });

    it('moves a function already on the trail back to the head', () => {
        const selection = createSelection();
        selection.click('a');
        selection.follow('b');
        selection.follow('a');

        expect(selection.list()).toEqual(['a', 'b']);
        expect(selection.trail).toEqual(['b', 'a']);
    });

    it('starts a fresh trail when a node is clicked', () => {
        const selection = createSelection();
        selection.click('a');
        selection.follow('b');
        selection.click('c');

        expect(selection.list()).toEqual(['c']);
    });

    it('keeps pinned functions when a click clears the trail', () => {
        const selection = createSelection();
        selection.click('a');
        selection.follow('b');
        selection.setPinned('b', true);
        selection.click('c');

        expect(selection.list()).toEqual(['c', 'b']);
    });

    it('ends the trail when nothing is clicked', () => {
        const selection = createSelection();
        selection.click('a');
        selection.follow('b');
        selection.click(null);

        expect(selection.list()).toEqual([]);
        expect(selection.clicked).toBe(null);
    });

    it('highlights every function on the trail', () => {
        const selection = createSelection();
        selection.click('a');
        selection.follow('b');

        expect([...selection.ids()].sort()).toEqual(['a', 'b']);
    });
});
