/*
 * Headless smoke test: loads the app, optionally selects a branch, expands a
 * file and a function, and reports console errors plus what was drawn.
 * Usage: node tools/smoke.js [branch] [screenshot-path]
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [branch, shot = path.join(tmpdir(), 'srcblocks-shot.png')] = process.argv.slice(2);
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const logs = [];
page.on('console', message => logs.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', error => logs.push(`[pageerror] ${error.message}`));
page.on('requestfailed', request => logs.push(`[reqfail] ${request.url()} ${request.failure()?.errorText}`));
page.on('response', response => {
    if (response.status() >= 400) {
        logs.push(`[http ${response.status()}] ${response.url()}`);
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

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle2' });
await settled();
console.log('INITIAL:', await page.$eval('#status-text', el => el.textContent));

if (branch) {
    await page.select('#branch-select', branch);
    await page
        .waitForFunction(() => /Analysing/.test(document.getElementById('status-text').textContent), { timeout: 10000 })
        .catch(() => {});
    await settled();
    await openBranchPanel();
    console.log('BRANCH:', await page.$eval('#status-text', el => el.textContent));
    console.log('COMMITS:', await page.$$eval('#commit-list li', items => items.length));
}

const statusCounts = () =>
    page.evaluate(() => {
        const counts = { nodes: {}, edges: {} };
        for (const node of document.querySelectorAll('#node-layer .node')) {
            const status = [...node.classList].find(name => name.startsWith('status-')) || 'none';
            counts.nodes[status] = (counts.nodes[status] || 0) + 1;
        }
        for (const edge of document.querySelectorAll('#edge-layer .edge')) {
            const status = [...edge.classList].find(name => name.startsWith('status-')) || 'none';
            counts.edges[status] = (counts.edges[status] || 0) + 1;
        }
        return counts;
    });

if (branch) {
    console.log('ALL COMMITS:', JSON.stringify(await statusCounts()));

    await page.click('#commits-none');
    await new Promise(resolve => setTimeout(resolve, 2000));
    await settled();
    console.log(
        'NO COMMITS:',
        await page.$eval('#status-text', el => el.textContent),
        JSON.stringify(await statusCounts()),
    );

    await page.evaluate(() => document.querySelectorAll('#commit-list input')[0].click());
    await new Promise(resolve => setTimeout(resolve, 2000));
    await settled();
    console.log(
        'ONE COMMIT:',
        await page.$eval('#status-text', el => el.textContent),
        JSON.stringify(await statusCounts()),
    );
}

console.log(
    'DRAWN:',
    await page.evaluate(() => ({
        nodes: document.querySelectorAll('#node-layer .node').length,
        edges: document.querySelectorAll('#edge-layer .edge').length,
        code: document.querySelectorAll('.node-code').length,
    })),
);
console.log('LOGS:', logs.length ? '\n' + logs.join('\n') : 'clean');
await page.screenshot({ path: shot });
await browser.close();
