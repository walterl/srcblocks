import fs from 'node:fs';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache']);

const isSourceFile = name => SOURCE_EXTENSIONS.includes(path.extname(name)) && !name.endsWith('.d.ts');

/*
 * Recursively lists analysable source files under `rootDir`, skipping build
 * output and dependency directories. Returns absolute paths.
 */
export function findSourceFiles(rootDir) {
    const found = [];

    const walk = dir => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
                    walk(full);
                }
            } else if (entry.isFile() && isSourceFile(entry.name)) {
                found.push(full);
            }
        }
    };

    walk(rootDir);
    return found.sort();
}

/*
 * Runs analysis in a TypeScript 7 snapshot over the JavaScript and TypeScript
 * files in `rootDir`. The snapshot owns the AST and checker for the duration of
 * the analysis.
 */
export function withProgram(rootDir, analyze) {
    rootDir = path.resolve(rootDir);
    const fileNames = findSourceFiles(rootDir);
    if (!fileNames.length) {
        return analyze({ sourceFiles: [] });
    }

    const compilerOptions = {
        allowJs: true,
        checkJs: false,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
        target: 'esnext',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        resolveJsonModule: false,
        types: [],
        lib: ['esnext'],
    };
    // Open a virtual project so the analyzer controls which files are included
    // even when a checkout has its own tsconfig or is read-only.
    const configPath = path.join(rootDir, 'tsconfig.srcblocks.json');
    const config = JSON.stringify({ compilerOptions, files: fileNames });
    const api = new API({
        cwd: rootDir,
        fs: {
            fileExists: file => (path.normalize(file) === configPath ? true : undefined),
            readFile: file => (path.normalize(file) === configPath ? config : undefined),
        },
    });
    try {
        const snapshot = api.updateSnapshot({ openProjects: [configPath] });
        try {
            const { program, checker } = snapshot.getProject(configPath);
            const sourceFiles = fileNames.map(file => program.getSourceFile(file)).filter(Boolean);
            return analyze({ program, checker, sourceFiles });
        } finally {
            snapshot.dispose();
        }
    } finally {
        api.close();
    }
}
