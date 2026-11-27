/*
 * Headless check of the canvas interactions that need a real pointer: dragging
 * a node inside its parent, pinning a node's edge highlight, and copying a
 * commit hash. It reads srcblocks's own source, so serve this checkout, and pick
 * a branch that changes src/git/repo.js: the calls check hovers a function there.
 * Usage: node tools/interact.js <branch> [screenshot-path]
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [branch, shot = path.join(tmpdir(), 'srcblocks-interact.png')] = process.argv.slice(2);
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const logs = [];
page.on('pageerror', error => logs.push(`[pageerror] ${error.message}`));
page.on('console', message => {
    if (message.type() === 'error') {
        logs.push(`[error] ${message.text()}`);
    }
});

/* The branch section folds itself away once a branch is chosen. */
const openBranchPanel = () =>
    page.evaluate(() => {
        const header = document.querySelector('#branch-panel .panel-header');
        if (header.getAttribute('aria-expanded') !== 'true') {
            header.click();
        }
    });

const settled = () =>
    page.waitForFunction(() => /nodes,/.test(document.getElementById('status-text').textContent), { timeout: 180000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle2' });
await settled();
await page.select('#branch-select', branch);
await pause(1000);
await settled();

/* A drawn function node that sits inside a drawn parent, with edges. */
const target = await page.evaluate(() => {
    const withParent = [...document.querySelectorAll('#node-layer .node.kind-function')].find(node => {
        const parentId = node.dataset.id.split('#')[0].replace('func:', 'file:');
        return document.querySelector(`.node[data-id="${CSS.escape(parentId)}"]`);
    });
    return withParent ? withParent.dataset.id : null;
});
console.log('target:', target);

/* Bring the node into view first: zooming towards something off screen only
   pushes it further away. */
const jumpTo = async id => {
    await page.evaluate(id => {
        document.getElementById('search-input').value = id.split('#').pop();
        document.getElementById('search-form').requestSubmit();
    }, id);
    await pause(600);
    const entry = await page.evaluateHandle(id => {
        const wanted = id.split('#').pop();
        return [...document.querySelectorAll('.search-entry')].find(e =>
            e.querySelector('.search-entry-name').textContent.startsWith(`${wanted}(`),
        );
    }, id);
    if (entry.asElement()) {
        await entry.asElement().click();
        await pause(2400);
        await settled();
    }
    await page.click('#search-close');
};
await jumpTo(target);
// Jumping opens the source; close it again so the drag has a plain node to grab.
await page.evaluate(id => document.querySelector(`.node[data-id="${CSS.escape(id)}"] .node-header`).click(), target);
await pause(1500);
await settled();

/* Zoom in on the node so the pointer has something real to grab. */
const centerOf = id =>
    page.evaluate(id => {
        const rect = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`).getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, id);

for (let step = 0; step < 8; step += 1) {
    const center = await centerOf(target);
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel({ deltaY: -400 });
    await pause(60);
}

/* Pinning keeps the node's edges highlighted with the pointer elsewhere. The
   pin lives in the menu the header opens, so the node has to be under the
   pointer to reach it - which is why this comes before the drags move it. */
const headerCenter = await page.evaluate(id => {
    const rect = document.querySelector(`.node[data-id="${CSS.escape(id)}"] .node-header`).getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}, target);
await page.mouse.move(headerCenter.x, headerCenter.y);
await page.mouse.move(headerCenter.x + 1, headerCenter.y);
await pause(300);
await page.click('#node-menu .node-pin');
await page.mouse.move(900, 980);
await pause(200);
console.log(
    'PIN:',
    JSON.stringify(
        await page.evaluate(
            id => ({
                pinnedClass: document.querySelector(`.node[data-id="${CSS.escape(id)}"]`).classList.contains('pinned'),
                highlighted: document.querySelectorAll('#edge-layer .edge.highlight').length,
                dimmed: document.querySelectorAll('#edge-layer .edge.dimmed').length,
            }),
            target,
        ),
    ),
);

const geometry = id =>
    page.evaluate(id => {
        const node = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
        const parentId = id.split('#')[0].replace('func:', 'file:');
        const parent = document.querySelector(`.node[data-id="${CSS.escape(parentId)}"]`);
        const box = element => ({
            left: parseFloat(element.style.left),
            top: parseFloat(element.style.top),
            width: element.offsetWidth,
            height: element.offsetHeight,
        });
        const rect = node.getBoundingClientRect();
        return {
            node: box(node),
            parent: parent ? box(parent) : null,
            screen: { x: rect.x + rect.width / 2, y: rect.y + 6 },
            open: Boolean(node.querySelector('.node-code')),
        };
    }, id);

const before = await geometry(target);
console.log(
    'grab point:',
    JSON.stringify(before.screen),
    '->',
    await page.evaluate(point => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit ? `${hit.className || hit.tagName} in ${hit.closest('.node')?.dataset.id}` : 'nothing';
    }, before.screen),
);
await page.mouse.move(before.screen.x, before.screen.y);
await page.mouse.down();
for (const step of [1, 2, 3, 4]) {
    await page.mouse.move(before.screen.x + step * 30, before.screen.y + step * 15);
    await pause(30);
}
await page.mouse.up();
await pause(300);
const after = await geometry(target);

const inside = box =>
    box.node.left >= box.parent.left &&
    box.node.top >= box.parent.top &&
    box.node.left + box.node.width <= box.parent.left + box.parent.width &&
    box.node.top + box.node.height <= box.parent.top + box.parent.height;

console.log(
    'DRAG: moved',
    JSON.stringify({
        dx: Math.round(after.node.left - before.node.left),
        dy: Math.round(after.node.top - before.node.top),
    }),
    'inside parent:',
    inside(after),
    'opened by drag:',
    after.open,
);

/* A drag beyond the parent's edge is clamped to stay inside it. */
const far = await geometry(target);
await page.mouse.move(far.screen.x, far.screen.y);
await page.mouse.down();
await page.mouse.move(far.screen.x - 400, far.screen.y - 3000);
await page.mouse.move(far.screen.x - 800, far.screen.y - 6000);
await page.mouse.up();
await pause(300);
const clamped = await geometry(target);
console.log(
    'CLAMP: inside parent:',
    inside(clamped),
    JSON.stringify({
        node: { left: Math.round(clamped.node.left), top: Math.round(clamped.node.top) },
        parent: { left: Math.round(clamped.parent.left), top: Math.round(clamped.parent.top) },
    }),
);

/* Dragging a container carries everything inside it. */
const containerId = target.split('#')[0].replace('func:', 'file:');
await jumpTo(target);
const childBefore = (await geometry(target)).node;
const containerCenter = await page.evaluate(id => {
    const rect = document.querySelector(`.node[data-id="${CSS.escape(id)}"] .node-header`).getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}, containerId);
await page.mouse.move(containerCenter.x, containerCenter.y);
await page.mouse.down();
await page.mouse.move(containerCenter.x + 60, containerCenter.y + 40);
await page.mouse.move(containerCenter.x + 120, containerCenter.y + 80);
await page.mouse.up();
await pause(300);
const childAfter = (await geometry(target)).node;
console.log(
    'CONTAINER DRAG: child moved by',
    JSON.stringify({
        dx: Math.round(childAfter.left - childBefore.left),
        dy: Math.round(childAfter.top - childBefore.top),
    }),
);

/* The wheel scrolls a function's source instead of zooming the canvas. */
const longFunction = 'func:src/app/api.js#registerEndpoints';
// Jumping opens it in the middle of the canvas, clear of the calls window.
await jumpTo(longFunction);
const bodyCenter = await page.evaluate(id => {
    const body = document.querySelector(`.node[data-id="${CSS.escape(id)}"] .node-body`);
    const rect = body.getBoundingClientRect();
    body.scrollTop = 0;
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    return {
        ...point,
        scrollable: body.scrollHeight - body.clientHeight,
        under: document.elementFromPoint(point.x, point.y)?.className,
    };
}, longFunction);
const transformBefore = await page.$eval('#world', world => world.style.transform);
await page.mouse.move(bodyCenter.x, bodyCenter.y);
await page.mouse.wheel({ deltaY: 200 });
await pause(200);
const scrolled = await page.evaluate(
    id => document.querySelector(`.node[data-id="${CSS.escape(id)}"] .node-body`).scrollTop,
    longFunction,
);
const transformAfter = await page.$eval('#world', world => world.style.transform);
console.log(
    'WHEEL OVER SOURCE:',
    JSON.stringify({
        pointer: { x: Math.round(bodyCenter.x), y: Math.round(bodyCenter.y), under: bodyCenter.under },
        scrollable: bodyCenter.scrollable,
        scrolled,
        zoomChanged: transformBefore !== transformAfter,
    }),
);

/* Away from a function's source the wheel still zooms. Framing everything
   leaves canvas between the nodes to point at. */
await page.click('#fit-view');
await pause(400);
const transformFitted = await page.$eval('#world', world => world.style.transform);
const empty = await page.evaluate(() => {
    for (let x = 400; x < 1500; x += 40) {
        for (let y = 120; y < 950; y += 40) {
            const hit = document.elementFromPoint(x, y);
            if (hit && hit.id === 'viewport') {
                return { x, y };
            }
        }
    }
    return { x: 700, y: 950 };
});
await page.mouse.move(empty.x, empty.y);
await page.mouse.wheel({ deltaY: -200 });
await pause(200);
console.log(
    'WHEEL OVER CANVAS: zoomChanged:',
    transformFitted !== (await page.$eval('#world', world => world.style.transform)),
);

/* Hovering a function lists its calls; clicking one jumps to the callee. */
await page.click('#fit-view');
await pause(400);
const caller = 'func:src/git/repo.js#defaultBase';
const callerPoint = await page.evaluate(id => {
    const rect = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`).getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}, caller);
await page.mouse.move(callerPoint.x, callerPoint.y);
await pause(400);
const listed = await page.evaluate(() => ({
    visible: !document.getElementById('calls-window').hasAttribute('hidden'),
    groups: [...document.querySelectorAll('.calls-group')].map(group => ({
        fn: group.querySelector('.calls-group-fn').textContent,
        open: group.classList.contains('open'),
    })),
    entries: [...document.querySelectorAll('.calls-entry')].map(entry => entry.textContent),
}));
console.log('CALLS WINDOW:', JSON.stringify(listed));

await page.click('.calls-entry');
await pause(2000);
await settled();
console.log(
    'JUMP:',
    JSON.stringify(
        await page.evaluate(() => {
            const flashed = document.querySelector('.node.flash');
            if (!flashed) {
                return { flashed: null };
            }
            const rect = flashed.getBoundingClientRect();
            const view = document.getElementById('viewport').getBoundingClientRect();
            return {
                flashed: flashed.dataset.id,
                offCentre: {
                    x: Math.round(rect.x + rect.width / 2 - (view.x + view.width / 2)),
                    y: Math.round(rect.y + rect.height / 2 - (view.y + view.height / 2)),
                },
                listsNow: document.querySelector('.calls-group-fn')?.textContent,
            };
        }),
    ),
);

/* Copying a commit hash must not change the commit selection. */
await openBranchPanel();
const shaBefore = await page.$eval('#commit-list .commit-sha', element => element.textContent);
const checkedBefore = await page.$$eval('#commit-list input:checked', items => items.length);
await page.click('#commit-list .commit-sha');
await pause(200);
const copied = await page.$eval('#commit-list .commit-sha', element => element.textContent);
const checkedAfter = await page.$$eval('#commit-list input:checked', items => items.length);
await pause(900);
const restored = await page.$eval('#commit-list .commit-sha', element => element.textContent);
console.log('COPY:', JSON.stringify({ shaBefore, copied, restored, checkedBefore, checkedAfter }));

console.log('LOGS:', logs.length ? logs.join('\n') : 'clean');
await page.screenshot({ path: shot });
await browser.close();
