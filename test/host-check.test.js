import { isLocalHostHeader, isLoopback, requireLocalHost } from '../src/app/host-check.js';

describe('isLocalHostHeader', () => {
    it.each(['127.0.0.1:4173', 'localhost:4173', '[::1]:4173', 'LocalHost:4173'])('accepts %s', header => {
        expect(isLocalHostHeader(header, 4173)).toBe(true);
    });

    it.each([
        ['a rebound domain', 'evil.example:4173'],
        ['a loopback name on another port', 'localhost:8080'],
        ['a name without its port', 'localhost'],
        ['a lookalike', 'localhost.evil.example:4173'],
        ['no header at all', undefined],
    ])('refuses %s', (_, header) => {
        expect(isLocalHostHeader(header, 4173)).toBe(false);
    });
});

describe('isLoopback', () => {
    it('tells loopback addresses from ones the network can reach', () => {
        expect(['127.0.0.1', 'localhost', '::1'].every(isLoopback)).toBe(true);
        expect(['0.0.0.0', '::', '192.168.1.10'].some(isLoopback)).toBe(false);
    });
});

describe('requireLocalHost', () => {
    /* What the middleware did with a request for `host`: passed it on, or the status it answered. */
    const outcome = host => {
        let result = null;
        const res = {
            status: code => {
                result = code;
                return res;
            },
            type: () => res,
            send: () => res,
        };
        requireLocalHost(4173)({ headers: { host } }, res, () => {
            result = 'next';
        });
        return result;
    };

    it('passes a request addressed to localhost on', () => {
        expect(outcome('localhost:4173')).toBe('next');
    });

    it('answers 403 to one addressed to any other name', () => {
        expect(outcome('evil.example:4173')).toBe(403);
    });
});
