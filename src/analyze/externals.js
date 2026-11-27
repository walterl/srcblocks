import { builtinModules } from 'node:module';
import { SERVICES } from '#srcblocks/config/env.js';

/*
 * What a dependency is, from the point of view of a reader following the flow
 * of data through a program: either a *service* - something outside the process
 * that the program talks to over a socket, a file descriptor or a driver - or a
 * *library*, which is just more code running here.
 *
 * The distinction is the whole point of naming externals at all: a service is
 * where the data leaves, and that is a boundary worth drawing. `lodash.map` is
 * not.
 */

/* Packages whose whole job is to reach something outside the process. */
const SERVICE_PACKAGES = new Set([
    // http clients
    'axios',
    'got',
    'node-fetch',
    'undici',
    'superagent',
    'ky',
    'request',
    'fetch',
    // databases and ORMs
    'pg',
    'pg-promise',
    'mysql',
    'mysql2',
    'mongodb',
    'mongoose',
    'redis',
    'ioredis',
    'sqlite3',
    'better-sqlite3',
    'knex',
    'sequelize',
    'prisma',
    '@prisma/client',
    'typeorm',
    'drizzle-orm',
    'kysely',
    // queues
    'amqplib',
    'kafkajs',
    'bullmq',
    'bull',
    // cloud SDKs
    'aws-sdk',
    'firebase-admin',
    // LLM SDKs
    'openai',
    '@anthropic-ai/sdk',
    '@google/generative-ai',
    // mail
    'nodemailer',
    '@sendgrid/mail',
    'postmark',
    // websockets
    'ws',
    'socket.io',
    'socket.io-client',
]);

/* Whole scopes that are services, matched as `@scope/anything`. */
const SERVICE_SCOPES = ['@aws-sdk', '@google-cloud', '@azure'];

/*
 * Node's own modules that do I/O. Every other builtin (`path`, `crypto`,
 * `util`, `stream`...) computes rather than talks, so it is a library.
 */
const SERVICE_BUILTINS = new Set([
    'fs',
    'fs/promises',
    'child_process',
    'http',
    'https',
    'http2',
    'net',
    'dns',
    'dgram',
    'tls',
]);

/* The http clients whose first argument is a URL, so a host can be named. */
export const HTTP_CLIENTS = new Set(['axios', 'got', 'node-fetch', 'undici', 'superagent', 'ky', 'request', 'fetch']);

const BUILTINS = new Set(builtinModules);

/*
 * Specifiers that name something inside the program rather than a dependency: a
 * relative or absolute path, or a `#name` subpath import, which the package's
 * own `imports` map points back into the repository.
 */
export const isInternalSpecifier = specifier => /^[./]/.test(specifier) || specifier.startsWith('#');

/*
 * The package an import specifier belongs to: the part that identifies the
 * dependency, without the subpath a module reaches into it by.
 *
 * Builtins keep a `node:` prefix whether they were written with one or not, so
 * that `fs` and `node:fs` are one node; their subpath is part of the identity
 * (`fs/promises` is its own module, not a deep import into `fs`).
 */
export function packageNameOf(specifier) {
    const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
    if (BUILTINS.has(bare)) {
        return `node:${bare}`;
    }
    const [head] = bare.split('/');
    if (BUILTINS.has(head)) {
        return `node:${head}`;
    }

    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/* Whether talking to this package means leaving the process. */
export function classify(packageName) {
    if (packageName.startsWith('node:')) {
        return SERVICE_BUILTINS.has(packageName.slice('node:'.length)) ? 'service' : 'library';
    }
    if (SERVICE_PACKAGES.has(packageName) || SERVICES.includes(packageName)) {
        return 'service';
    }
    if (SERVICE_SCOPES.some(scope => packageName.startsWith(`${scope}/`))) {
        return 'service';
    }
    return 'library';
}

export const packageNodeId = packageName => `ext:pkg:${packageName}`;
export const hostNodeId = hostname => `ext:host:${hostname}`;

/* The graph node standing for a package, named the way it is imported. */
export const packageNode = packageName => ({
    id: packageNodeId(packageName),
    kind: 'external',
    name: packageName,
    externalKind: classify(packageName),
    parent: null,
    package: packageName,
    host: null,
});

/*
 * The graph node standing for one host a program talks to. A hostname read off
 * a literal URL says far more about where the data goes than the name of the
 * client library that carried it there.
 */
export const hostNode = (hostname, packageName) => ({
    id: hostNodeId(hostname),
    kind: 'external',
    name: hostname,
    externalKind: 'service',
    parent: null,
    package: packageName || null,
    host: hostname,
});
