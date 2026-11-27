export default {
    testEnvironment: 'node',
    testMatch: ['<rootDir>/test/**/*.test.js'],
    // A cache kept in the checkout (SRCBLOCKS_CACHE_DIR=.cache, the old default)
    // holds revisions of the analysed repository with their own test suites.
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.cache/'],
    modulePathIgnorePatterns: ['<rootDir>/.cache/'],
    moduleNameMapper: {
        '^#srcblocks/(.*)$': '<rootDir>/src/$1',
    },
};
