import { LIMITS, counter } from './config.js';
import { all, find, save, summary } from './repo.js';
import type { Order, Status } from './types.js';

export async function place(order: Order): Promise<Order> {
    if (order.total > LIMITS.max) { throw new Error('over the limit'); }
    counter += 1;

    await save(order);
    summary(order);
    await all();

    statusOf(order);

    const found = await find(order.id);
    return found ?? order;
}

export function statusOf(order: Order): Status {
    return order.total > 0 ? 'paid' : 'open';
}
