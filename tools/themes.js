/*
 * Checks that every theme in the picker resolves every token the stylesheets
 * ask for.
 *
 * A theme is a block of tokens, and a rule that asks for one the theme forgot
 * is not an error anywhere: the property simply drops out, and the page quietly
 * loses a colour or a font. That is invisible in the theme being worked on and
 * obvious in all the others, which is exactly the wrong way round.
 * Usage: node tools/themes.js [url]
 */
import puppeteer from 'puppeteer-core';

const [url = 'http://localhost:4173/'] = process.argv.slice(2);
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle2' });

const themes = await page.evaluate(() =>
    [...document.querySelectorAll('#theme-select option')].map(option => option.value),
);

/* Every --token the stylesheets read, whatever they read it for. */
const wanted = await page.evaluate(() => {
    const names = new Set();
    for (const sheet of document.styleSheets) {
        let rules;
        try {
            rules = sheet.cssRules;
        } catch {
            continue;
        }
        for (const rule of rules) {
            for (const [, name] of (rule.cssText || '').matchAll(/var\((--[a-z0-9-]+)/g)) {
                names.add(name);
            }
        }
    }
    return [...names].sort();
});

/* Something that is asked for by name but resolves to nothing at all. */
const SENTINEL = 'rgb(255, 0, 255)';
const failures = [];

for (const theme of themes) {
    const found = await page.evaluate(
        (chosen, tokens, sentinel) => {
            document.documentElement.dataset.theme = chosen;
            const root = getComputedStyle(document.documentElement);
            const undefined_ = tokens.filter(token => !root.getPropertyValue(token).trim());

            // A token defined in terms of a missing one is still missing, and
            // only shows up once something tries to paint with it.
            const outer = document.createElement('span');
            outer.style.color = sentinel;
            outer.style.font = '11px "srcblocks-sentinel"';
            const inner = document.createElement('span');
            outer.append(inner);
            document.body.append(outer);

            const broken = [];
            for (const token of ['--accent', '--added', '--changed', '--removed', '--test', '--edge', '--text']) {
                inner.style.color = `var(${token})`;
                if (getComputedStyle(inner).color === sentinel) {
                    broken.push(token);
                }
            }
            inner.style.color = '';
            inner.style.font = 'var(--font)';
            const font = getComputedStyle(inner).fontFamily;
            outer.remove();

            return { undefined_, broken, font };
        },
        theme,
        wanted,
        SENTINEL,
    );

    const trouble = [
        found.undefined_.length ? `undefined: ${found.undefined_.join(' ')}` : '',
        found.broken.length ? `paints nothing: ${found.broken.join(' ')}` : '',
        found.font === '"srcblocks-sentinel"' ? '--font did not apply' : '',
    ].filter(Boolean);

    if (trouble.length) {
        failures.push(`${theme}: ${trouble.join('; ')}`);
    }
    console.log(`${trouble.length ? 'FAIL' : 'ok  '} ${theme.padEnd(17)} ${trouble.join('; ')}`);
}

await browser.close();
console.log(`\n${themes.length} themes, ${wanted.length} tokens asked for by the stylesheets`);
if (failures.length) {
    console.error(`\n${failures.length} theme(s) with missing tokens.`);
    process.exit(1);
}
