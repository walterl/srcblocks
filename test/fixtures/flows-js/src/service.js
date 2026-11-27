import { LIMITS, counter } from './config.js';
import { save } from './repo.js';

/**
 * @param {import('./types.js').Order} order
 * @returns {Promise<import('./types.js').Order>}
 */
export async function place(order) {
    if (order.total > LIMITS.max) {
        throw new Error('over the limit');
    }
    counter += 1;
    await save(order);
    return order;
}
