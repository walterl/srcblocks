import { Pool } from 'pg';
import path from 'node:path';
import type { Order } from './types.js';

const pool = new Pool();

export async function save(order: Order): Promise<void> {
    await pool.query('insert into orders (id) values ($1)', [order.id]);
}

export async function find(id: string): Promise<Order | null> {
    const result = await pool.query('select * from orders where id = $1', [id]);
    return (result?.rows?.[0] as Order) ?? null;
}

export async function all(): Promise<Order[]> {
    const result = await pool.query('select * from orders');
    return (result?.rows as Order[]) ?? [];
}

export function summary(order: Order): { count: number; total: number } {
    return { count: order.lines.length, total: order.total };
}

export function cachePath(name: string): string {
    return path.join('/tmp', name);
}

export async function ping(): Promise<void> {
    await fetch('https://api.example.com/v1/health');
}
