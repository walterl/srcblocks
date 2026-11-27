export interface Line {
    sku: string;
    qty: number;
}

export interface Order {
    id: string;
    total: number;
    lines: Line[];
}

export type Status = 'open' | 'paid';
