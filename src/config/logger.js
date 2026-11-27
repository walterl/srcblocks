const timestamp = () => new Date().toISOString();

export const logger = {
    info: (message, meta) => console.log(`${timestamp()} ${message}`, meta ?? ''),
    warn: (message, meta) => console.warn(`${timestamp()} ${message}`, meta ?? ''),
    error: (message, meta) => console.error(`${timestamp()} ${message}`, meta ?? ''),
};
