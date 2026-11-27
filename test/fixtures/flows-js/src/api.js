import { place } from './service.js';

/** @param {{ body: import('./types.js').Order }} req */
export async function handle(req) {
    return place(req.body);
}
