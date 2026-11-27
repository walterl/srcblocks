const { level } = { level: 2 };

export function read(limit) {
    return Math.min(level, limit);
}
