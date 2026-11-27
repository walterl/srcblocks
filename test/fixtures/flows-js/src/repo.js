const { Pool } = require('pg');

const pool = new Pool();

export async function save(order) {
    pool.query('insert into orders (id) values ($1)');
    return order;
}

export async function touch(order) {
    return save(order);
}
