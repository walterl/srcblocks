import { place } from './service.js';
import type { Order } from './types.js';

export async function handle(req: { body: Order }): Promise<Order> {
    return place(req.body);
}
