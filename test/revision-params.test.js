import express from 'express';
import { registerEndpoints, unsafeRevisionParam } from '../src/app/api.js';

describe('unsafeRevisionParam', () => {
    it('accepts revision names and leaves out parameters that are absent', () => {
        expect(unsafeRevisionParam({})).toBeUndefined();
        expect(
            unsafeRevisionParam({ ref: 'origin/main', base: 'HEAD~2', head: 'a1b2c3d', path: 'src/a.js' }),
        ).toBeUndefined();
    });

    it.each(['ref', 'sha', 'base', 'head', 'name'])('names %s when git would read it as an option', key => {
        expect(unsafeRevisionParam({ [key]: '--output=/tmp/x' })).toBe(key);
        expect(unsafeRevisionParam({ [key]: '-p' })).toBe(key);
    });

    it('names a revision given more than once, which arrives as an array', () => {
        expect(unsafeRevisionParam({ ref: ['main', '--contents=/etc/passwd'] })).toBe('ref');
    });

    it('lets a path start with -, since it only reaches git after -- or behind a revision', () => {
        expect(unsafeRevisionParam({ ref: 'main', path: '-odd.js' })).toBeUndefined();
    });
});

describe('the API', () => {
    let server;
    let origin;

    beforeAll(async () => {
        const app = express();
        registerEndpoints(app);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        origin = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(() => new Promise(resolve => server.close(resolve)));

    // Every endpoint, with each revision parameter it takes set to an option.
    it.each([
        '/api/graph?ref=--output=x',
        '/api/file?path=a.js&ref=--output=x',
        '/api/file?path=a.js&ref=main&base=--output=x',
        '/api/blame?path=a.js&ref=--contents=/etc/passwd',
        '/api/commit?sha=--output=x',
        '/api/file-diff?path=a.js&base=--output=x&head=main',
        '/api/file-diff?path=a.js&base=main&head=--output=x',
        '/api/branch?name=--output=x',
        '/api/branch?name=main&base=--output=x',
    ])('answers 400 to %s before git sees it', async url => {
        const response = await fetch(`${origin}${url}`);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toMatch(/not starting with -/);
    });
});
