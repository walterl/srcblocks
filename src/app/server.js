import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, INCLUDE, PORT, REPO_DIR } from '#srcblocks/config/env.js';
import { logger } from '#srcblocks/config/logger.js';
import { registerEndpoints } from '#srcblocks/app/api.js';
import { isLoopback, requireLocalHost } from '#srcblocks/app/host-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeModules = path.resolve(__dirname, '../../node_modules');

const app = express();

// Served on loopback, only requests addressed to localhost are answered, which
// keeps a page that rebinds its domain to 127.0.0.1 out. Bound to any other
// address, the server was deliberately put on the network.
if (isLoopback(HOST)) {
    app.use(requireLocalHost(PORT));
}

app.use(express.static(path.join(__dirname, 'public')));

// Third-party browser libraries are served from node_modules so the app runs
// completely offline - no CDN, no network access at all.
app.use('/vendor/highlight', express.static(path.join(nodeModules, 'highlight.js')));

// highlight.js ships its core as CommonJS and its languages as ES modules. The
// core is self-contained (no `require` calls), so a two-line wrapper is enough
// to import it directly in the browser.
app.get('/vendor/highlight/core.mjs', (_req, res) => {
    const source = fs.readFileSync(path.join(nodeModules, 'highlight.js/lib/core.js'), 'utf8');
    res.type('application/javascript').send(
        `const module = { exports: {} };\n${source}\nexport default module.exports;`,
    );
});

registerEndpoints(app);

app.listen(PORT, HOST, () => {
    logger.info(`srcblocks on http://${HOST}:${PORT}`, {
        repo: REPO_DIR,
        include: INCLUDE.length ? INCLUDE.join(',') : '(all)',
    });
});
