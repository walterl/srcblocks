/*
 * Opens a function node's source on the canvas and screenshots it at 1:1.
 * Usage: node tools/focus.js <branch|-> <node-id-substring|.css-class> [screenshot-path]
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [branch, needle, shot = path.join(tmpdir(), 'srcblocks-focus.png')] = process.argv.slice(2);
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

const settled = () =>
    page.waitForFunction(() => /nodes,/.test(document.getElementById('status-text').textContent), { timeout: 180000 });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle2' });
await settled();
if (branch && branch !== '-') {
    await page.select('#branch-select', branch);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await settled();
}

const clicked = await page.evaluate(needle => {
    const nodes = [...document.querySelectorAll('#node-layer .node')];
    const node = needle.startsWith('.')
        ? nodes.find(element => element.matches(needle))
        : nodes.find(element => element.dataset.id.includes(needle));
    if (!node) {
        return null;
    }
    node.querySelector('.node-header').click();
    return node.dataset.id;
}, needle);
console.log('clicked:', clicked);
await new Promise(resolve => setTimeout(resolve, 2500));
await settled();

const focused = await page.evaluate(id => {
    const node = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
    if (!node) {
        return null;
    }
    const left = parseFloat(node.style.left);
    const top = parseFloat(node.style.top);
    document.getElementById('world').style.transform = `translate(${-left + 360}px, ${-top + 120}px) scale(1)`;
    return {
        left,
        top,
        width: node.offsetWidth,
        height: node.offsetHeight,
        code: Boolean(node.querySelector('.node-code')),
    };
}, clicked);
console.log('focused:', focused);
console.log('logs:', logs.length ? logs.join('\n') : 'clean');
await page.screenshot({ path: shot });
await browser.close();
