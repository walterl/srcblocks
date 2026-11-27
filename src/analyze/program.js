import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

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
 * Creates a TypeScript program over every source file in `rootDir`. The program
 * powers both declaration collection and (type checker backed) call resolution,
 * for JavaScript as well as TypeScript sources.
 */
export function createProgram(rootDir) {
    const fileNames = findSourceFiles(rootDir);
    const options = {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
        allowNonTsExtensions: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        resolveJsonModule: false,
        types: [],
        lib: ['lib.esnext.d.ts'],
    };
    const host = ts.createCompilerHost(options, true);
    host.getCurrentDirectory = () => rootDir;

    const program = ts.createProgram({ rootNames: fileNames, options, host });
    const sourceFiles = fileNames
        .map(name => program.getSourceFile(name))
        .filter(file => file && !program.isSourceFileDefaultLibrary(file));

    return { program, checker: program.getTypeChecker(), sourceFiles };
}
