import { cacheDir } from '../src/lib/cache.js';

describe('cacheDir', () => {
    const home = '/home/someone';

    it('takes SRCBLOCKS_CACHE_DIR over everything else', () => {
        expect(cacheDir({ SRCBLOCKS_CACHE_DIR: '/var/cache/sb', XDG_CACHE_HOME: '/xdg' }, home)).toBe('/var/cache/sb');
    });

    it('lives under XDG_CACHE_HOME when it is set', () => {
        expect(cacheDir({ XDG_CACHE_HOME: '/xdg' }, home)).toBe('/xdg/srcblocks');
    });

    it('falls back to ~/.cache when XDG_CACHE_HOME is unset, empty or relative', () => {
        expect(cacheDir({}, home)).toBe('/home/someone/.cache/srcblocks');
        expect(cacheDir({ XDG_CACHE_HOME: '' }, home)).toBe('/home/someone/.cache/srcblocks');
        expect(cacheDir({ XDG_CACHE_HOME: 'relative/cache' }, home)).toBe('/home/someone/.cache/srcblocks');
    });

    it('treats an empty SRCBLOCKS_CACHE_DIR as unset', () => {
        expect(cacheDir({ SRCBLOCKS_CACHE_DIR: '', XDG_CACHE_HOME: '/xdg' }, home)).toBe('/xdg/srcblocks');
    });
});
