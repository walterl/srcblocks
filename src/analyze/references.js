import { SymbolFlags } from 'typescript/unstable/sync';
import * as ast from 'typescript/unstable/ast';
import { fileId, relativePath } from '#srcblocks/analyze/collect.js';

/*
 * Where every name in a node's source is defined, so that the reader can go
 * there: `refs` on each function and data node, one entry per identifier the
 * checker resolves to a declaration in the analysed files.
 *
 * An entry is `[line, column, length, target, targetLine?]`, positioned in the
 * node's own `code` - `line` counts from its first line, `column` along that
 * line of it - and kept as a tuple because there is one for nearly every name
 * in the tree. `target` is the node that shows the definition: the node the
 * declaration is, when it is one, and `targetLine` is then left off; otherwise
 * the function or constant whose source holds it (a local, a parameter), or,
 * failing that, its file, with the line it is declared on.
 *
 * A name the checker cannot place, or places outside the analysed files - a
 * global, a package, the standard library - has no entry: there is nothing in
 * the tree to go to.
 */
export function attachReferences(collected, checker, { rootDir, sourceFiles }) {
    const { nodes, sourceAnchors, idByDeclaration, dataByDeclaration } = collected;
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const analysed = new Set(sourceFiles);
    const anchorsByFile = groupAnchorsByFile(sourceAnchors);

    const locate = declaration => {
        const direct = idByDeclaration.get(declaration) || dataByDeclaration.get(declaration);
        if (direct) {
            return [direct];
        }

        const sourceFile = declaration.getSourceFile();
        if (!analysed.has(sourceFile)) {
            return null;
        }

        const position = (declaration.name || declaration).getStart(sourceFile);
        const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
        const holder = (anchorsByFile.get(sourceFile) || []).find(
            entry => entry.start <= position && position < entry.end,
        );
        return [holder ? holder.id : fileId(relativePath(rootDir, sourceFile.fileName)), line];
    };

    for (const { id, anchor } of sourceAnchors) {
        nodeById.get(id).refs = referencesIn(anchor, checker, locate);
    }
    return nodes;
}

/*
 * The anchors by file, innermost first - so that a declaration inside two of
 * them (one statement declaring a function and a constant) is placed in the
 * smaller.
 */
function groupAnchorsByFile(sourceAnchors) {
    const byFile = new Map();
    for (const { id, anchor } of sourceAnchors) {
        const sourceFile = anchor.getSourceFile();
        if (!byFile.has(sourceFile)) {
            byFile.set(sourceFile, []);
        }
        byFile.get(sourceFile).push({ id, start: anchor.getStart(sourceFile), end: anchor.getEnd() });
    }
    for (const anchors of byFile.values()) {
        anchors.sort((a, b) => a.end - a.start - (b.end - b.start));
    }
    return byFile;
}

function referencesIn(anchor, checker, locate) {
    const sourceFile = anchor.getSourceFile();
    const start = anchor.getStart(sourceFile);
    const end = anchor.getEnd();
    const origin = sourceFile.getLineAndCharacterOfPosition(start);
    const refs = [];

    const visit = node => {
        if (ast.isIdentifier(node)) {
            const position = node.getStart(sourceFile);
            // The native compiler includes types from leading JSDoc in the
            // tree. Their positions belong to the comment, outside this code.
            if (position < start || node.getEnd() > end) {
                return;
            }
            const declaration = definitionOf(node, checker);
            // A name where it is declared is the definition, not a way to it.
            const target = declaration && declaration.name !== node ? locate(declaration) : null;
            if (target) {
                const at = sourceFile.getLineAndCharacterOfPosition(position);
                const line = at.line - origin.line;
                // The code starts where the anchor does, so its first line is
                // measured from the anchor's column rather than the file's.
                const column = line === 0 ? at.character - origin.character : at.character;
                refs.push([line, column, node.text.length, ...target]);
            }
        }
        node.forEachChild(visit);
    };
    visit(anchor);
    return refs;
}

/*
 * The declaration a name refers to. An import is followed to what it imports,
 * which is where the reader wants to go, and `{ name }` to the variable it is
 * built from rather than the property it creates.
 */
function definitionOf(identifier, checker) {
    let symbol = ast.isShorthandPropertyAssignment(identifier.parent)
        ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & SymbolFlags.Alias) {
        try {
            symbol = checker.getAliasedSymbol(symbol);
        } catch {
            return null;
        }
    }
    return symbol?.declarations[0]?.resolve();
}
