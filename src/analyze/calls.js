import { SymbolFlags } from 'typescript/unstable/sync';
import * as ast from 'typescript/unstable/ast';
import {
    HTTP_CLIENTS,
    hostNode,
    isInternalSpecifier,
    packageNameOf,
    packageNode,
} from '#srcblocks/analyze/externals.js';
import { packageFromPath } from '#srcblocks/analyze/flows.js';

export const callEdgeId = (source, target) => `call:${source}->${target}`;

/* How far a local binding is followed back to the import that produced it. */
const MAX_BINDING_HOPS = 5;

/*
 * Globals that reach the network. Every other lib global (`console`, `Math`,
 * `JSON`, `Promise`, `setTimeout`, the methods of `Array`) is not a boundary -
 * `[].map()` is a loop, not a dependency - so they produce no external node and
 * stay counted as unresolved.
 */
const NETWORK_GLOBALS = new Set(['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']);

/*
 * A `@types/...` package declares types for code that lives somewhere else - a
 * global, or one of Node's own modules - so a call whose declaration was found
 * there is not a call into a dependency of that name.
 */
const isTypesOnly = packageName => packageName.startsWith('@types/');

/*
 * Walks every collected function body and resolves its call expressions to
 * other graph nodes, producing the call edges of the graph.
 *
 * A call that leaves the analysed sources is not nothing: a query, an http
 * request or a write to disk is the most interesting thing a function does. So
 * calls that reach a package or a known global become edges to an external
 * node, and only calls that resolve to nothing at all are counted and dropped.
 */
export function resolveCalls({ functionDecls, idByDeclaration }, checker, program = null) {
    const edges = new Map();
    const sitesByEdge = new Map();
    const externals = new Map();
    const stats = { resolved: 0, external: 0, nested: 0, externals: { service: 0, library: 0 } };

    for (const { id: sourceId, decl } of functionDecls) {
        const body = decl.body || decl;
        visitCalls(body, call => {
            const target = resolveCallTarget(call, checker, idByDeclaration);
            if (!target) {
                const external = externalTarget(call, checker, program);
                if (!external) {
                    stats.external += 1;
                    return;
                }
                if (!externals.has(external.id)) {
                    externals.set(external.id, external);
                }
                addEdge(edges, sitesByEdge, sourceId, external.id, call);
                return;
            }
            // A non-exact match on the caller itself means the callee is a
            // nested helper folded into this node - the call is already visible
            // in its source, and drawing it would fake recursion.
            if (target.id === sourceId && !target.exact) {
                stats.nested += 1;
                return;
            }
            stats.resolved += 1;
            addEdge(edges, sitesByEdge, sourceId, target.id, call);
        });
    }

    for (const node of externals.values()) {
        stats.externals[node.externalKind] += 1;
    }

    return { edges: [...edges.values()], stats, sitesByEdge, externals };
}

function addEdge(edges, sitesByEdge, source, target, call) {
    const id = callEdgeId(source, target);
    // The call sites are kept beside the edges rather than on them: they are
    // AST nodes, and an edge has to survive being turned into JSON.
    if (!sitesByEdge.has(id)) {
        sitesByEdge.set(id, []);
    }
    sitesByEdge.get(id).push(call);

    const existing = edges.get(id);
    if (existing) {
        existing.callCount += 1;
        return;
    }
    const sourceFile = call.getSourceFile();
    edges.set(id, {
        id,
        source,
        target,
        kind: 'call',
        recursive: source === target,
        callCount: 1,
        // Where the caller calls it first. Bodies are walked in source order,
        // so the first call site to arrive is the first one written.
        line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1,
        callText: call.expression.getText().slice(0, 80),
    });
}

function visitCalls(node, onCall) {
    const visit = current => {
        if (ast.isCallExpression(current) || ast.isNewExpression(current)) {
            onCall(current);
        }
        current.forEachChild(visit);
    };
    visit(node);
}

function resolveCallTarget(call, checker, idByDeclaration) {
    for (const declaration of targetDeclarations(call, checker)) {
        const match = graphIdForDeclaration(declaration, idByDeclaration);
        if (match) {
            return match;
        }
    }
    return null;
}

/*
 * Candidate declarations a call could reach: the resolved signature first (it
 * handles overloads and `this`-typed method calls), then the callee symbol,
 * which covers imported aliases and plain identifiers.
 */
function targetDeclarations(call, checker) {
    const candidates = [];

    const signature = checker.getResolvedSignature(call);
    if (signature?.declaration) {
        candidates.push(signature.declaration.resolve());
    }

    let symbol = checker.getSymbolAtLocation(call.expression);
    if (symbol && symbol.flags & SymbolFlags.Alias) {
        try {
            symbol = checker.getAliasedSymbol(symbol);
        } catch {
            // Unresolvable alias (e.g. missing module); keep the local symbol.
        }
    }
    for (const declaration of symbol?.declarations || []) {
        candidates.push(declaration.resolve());
    }

    return candidates;
}

/*
 * Maps a declaration returned by the checker onto a collected graph node.
 * Declarations arrive in many shapes (`const f = () => {}` resolves to the
 * variable declaration, an import specifier resolves to the imported symbol's
 * declaration), so unregistered ones are matched by walking outwards.
 */
function graphIdForDeclaration(declaration, idByDeclaration) {
    if (!declaration) {
        return null;
    }

    const direct = idByDeclaration.get(declaration);
    if (direct) {
        return { id: direct, exact: true };
    }

    if (ast.isVariableDeclaration(declaration) && declaration.initializer) {
        const viaInitializer = idByDeclaration.get(declaration.initializer);
        if (viaInitializer) {
            return { id: viaInitializer, exact: true };
        }
    }

    // Only declarations that are themselves callable (an unregistered nested
    // function, or `new Foo()` landing on a class without a constructor) may
    // borrow their enclosing node's identity. Walking out of a local binding
    // would otherwise attribute the call to the function that contains it.
    if (!ast.isFunctionLikeDeclaration(declaration) && !ast.isClassLikeDeclaration(declaration)) {
        return null;
    }

    let current = declaration.parent;
    while (current && !ast.isSourceFile(current)) {
        const id = idByDeclaration.get(current);
        if (id) {
            return { id, exact: false };
        }
        current = current.parent;
    }

    return null;
}

/*
 * The external node a call reaches, or null when it reaches nothing nameable.
 *
 * Identity comes from the import specifier, not from where the checker found a
 * declaration: analysed trees are extracted with `git archive` and have no
 * `node_modules`, so `import { Pool } from 'pg'` types as `any` and has no
 * declaration file to read a package name off. The specifier is written in the
 * source and is therefore always there.
 */
export function externalTarget(call, checker, program) {
    const root = rootIdentifier(call.expression) || fieldProducer(call.expression);
    if (!root) {
        return null;
    }

    const packageName = packageOfIdentifier(root, checker, program, 0);
    if (packageName) {
        return nodeFor(packageName, call);
    }

    // `fetch` and friends belong to the platform, so there is no specifier to
    // read; without lib.dom they have no declaration either, which is why an
    // unresolved global of that name counts too.
    const symbol = checker.getSymbolAtLocation(root);
    if (NETWORK_GLOBALS.has(root.text) && (!symbol || isLibSymbol(symbol, program))) {
        return nodeFor('fetch', call);
    }

    return null;
}

/*
 * An http client's first argument is the URL it talks to, and a hostname read
 * off a literal says where the data actually goes - `api.example.com` rather
 * than `axios`. A URL built from a config object is not guessed at.
 */
function nodeFor(packageName, call) {
    if (HTTP_CLIENTS.has(packageName)) {
        const hostname = literalHostOf(call);
        if (hostname) {
            return hostNode(hostname, packageName);
        }
    }
    return packageNode(packageName);
}

function literalHostOf(call) {
    const [first] = call.arguments || [];
    if (!first) {
        return null;
    }

    let text = null;
    if (ast.isStringLiteralLikeNode(first)) {
        text = first.text;
    } else if (ast.isTemplateExpression(first)) {
        // `https://api.example.com/orders/${id}` - the host is in the head.
        text = first.head.text;
    }
    if (!text) {
        return null;
    }

    try {
        return new URL(text).hostname || null;
    } catch {
        return null;
    }
}

/*
 * The root of a callee expression: what `a.b.c()`, `new X()`, `x()()` and
 * `(await client()).query()` all hang off. `this.x()` has no root identifier,
 * which is right - it is not a dependency.
 */
function rootIdentifier(expression) {
    let current = expression;
    while (current) {
        if (ast.isIdentifier(current)) {
            return current;
        }
        if (
            ast.isPropertyAccessExpression(current) ||
            ast.isElementAccessExpression(current) ||
            ast.isCallExpression(current) ||
            ast.isNewExpression(current) ||
            ast.isParenthesizedExpression(current) ||
            ast.isNonNullExpression(current) ||
            ast.isAwaitExpression(current) ||
            ast.isAsExpression(current)
        ) {
            current = current.expression;
            continue;
        }
        return null;
    }
    return null;
}

/*
 * `this.pool.query()`: the field a method reaches through has no root
 * identifier, but what the class put in that field does. The class that wraps
 * a driver is where the boundary is, so its methods are the calls into it.
 */
function fieldProducer(expression) {
    let current = expression;
    while (current && !ast.isPropertyAccessExpression(current)) {
        if (ast.isCallExpression(current) || ast.isElementAccessExpression(current) || ast.isAwaitExpression(current)) {
            current = current.expression;
            continue;
        }
        return null;
    }
    // Down to the innermost access, which is where `this` would be.
    while (current && ast.isPropertyAccessExpression(current.expression)) {
        current = current.expression;
    }
    if (!current || current.expression.kind !== ast.SyntaxKind.ThisKeyword) {
        return null;
    }

    let classNode = current.parent;
    while (classNode && !ast.isClassLikeDeclaration(classNode)) {
        classNode = classNode.parent;
    }
    if (!classNode) {
        return null;
    }
    const field = current.name.text;

    for (const member of classNode.members) {
        if (ast.isPropertyDeclaration(member) && member.name.getText() === field && member.initializer) {
            return rootIdentifier(member.initializer);
        }
        if (ast.isConstructorDeclaration(member) && member.body) {
            const assigned = fieldAssignment(member.body, field);
            if (assigned) {
                return rootIdentifier(assigned);
            }
        }
    }
    return null;
}

/* The right-hand side of `this.<field> = ...` in a constructor body, if any. */
function fieldAssignment(body, field) {
    let found = null;
    const visit = node => {
        if (found) {
            return;
        }
        if (
            ast.isBinaryExpression(node) &&
            node.operatorToken.kind === ast.SyntaxKind.EqualsToken &&
            ast.isPropertyAccessExpression(node.left) &&
            node.left.expression.kind === ast.SyntaxKind.ThisKeyword &&
            node.left.name.text === field
        ) {
            found = node.right;
            return;
        }
        node.forEachChild(visit);
    };
    visit(body);
    return found;
}

/*
 * The package an identifier ultimately comes from. A binding is followed back
 * to what produced it, so that `const pool = new Pool()` makes `pool.query()`
 * a call into `pg` - which is what it is.
 */
function packageOfIdentifier(identifier, checker, program, hops) {
    if (hops > MAX_BINDING_HOPS) {
        return null;
    }

    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) {
        return null;
    }
    // The default libs are shipped inside the `typescript` package, so a global
    // would otherwise be read off its path as a dependency on the compiler.
    if (isLibSymbol(symbol, program)) {
        return null;
    }

    // The local declaration of an import carries the specifier whether the
    // module resolved or not, so the aliased symbol is only needed for an
    // import from inside the program: `import { pool } from './db.js'` names
    // no package, but what `pool` was made from might - a query through a
    // connection another file opened is still a query.
    const specifier = specifierOf(declarationsOf(symbol));
    if (specifier) {
        if (!isInternalSpecifier(specifier)) {
            const named = packageNameOf(specifier);
            return isTypesOnly(named) ? null : named;
        }
        return packageOfSymbol(aliasedSymbol(symbol, checker), checker, program, hops + 1);
    }

    return packageOfSymbol(symbol, checker, program, hops);
}

/* The package a symbol's own declarations lead to, by path or by producer. */
function packageOfSymbol(symbol, checker, program, hops) {
    if (!symbol || hops > MAX_BINDING_HOPS) {
        return null;
    }

    const declarations = declarationsOf(symbol);
    for (const decl of declarations) {
        const fromPath = packageFromPath(decl.getSourceFile().fileName);
        if (fromPath) {
            return isTypesOnly(fromPath) ? null : fromPath;
        }
    }

    for (const decl of declarations) {
        const producer = producingIdentifier(decl);
        if (producer) {
            return packageOfIdentifier(producer, checker, program, hops + 1);
        }
    }
    return null;
}

function aliasedSymbol(symbol, checker) {
    if (!(symbol.flags & SymbolFlags.Alias)) {
        return symbol;
    }
    try {
        return checker.getAliasedSymbol(symbol);
    } catch {
        return null;
    }
}

/* The module specifier a declaration imports from, if it is an import at all. */
function specifierOf(declarations) {
    for (const decl of declarations || []) {
        if (ast.isImportSpecifier(decl) || ast.isImportClause(decl) || ast.isNamespaceImport(decl)) {
            const importDecl = ast.isImportSpecifier(decl) ? decl.parent.parent.parent : decl.parent;
            const moduleSpecifier = importDecl?.moduleSpecifier;
            if (moduleSpecifier && ast.isStringLiteralLikeNode(moduleSpecifier)) {
                return moduleSpecifier.text;
            }
        }
        if (ast.isImportEqualsDeclaration(decl) && ast.isExternalModuleReference(decl.moduleReference)) {
            const reference = decl.moduleReference.expression;
            if (ast.isStringLiteralLikeNode(reference)) {
                return reference.text;
            }
        }
        // CommonJS: `const pg = require('pg')`, `require('pg').Pool`, and
        // `const { Pool } = require('pg')`, whose binding element hangs off the
        // same variable declaration.
        const variable = ast.isBindingElement(decl) ? enclosingVariable(decl) : decl;
        if (variable && ast.isVariableDeclaration(variable) && variable.initializer) {
            const required = requiredSpecifier(variable.initializer);
            if (required) {
                return required;
            }
        }
    }
    return null;
}

function enclosingVariable(node) {
    let current = node.parent;
    while (current && !ast.isVariableDeclaration(current)) {
        current = current.parent;
    }
    return current || null;
}

function requiredSpecifier(expression) {
    const call = ast.isPropertyAccessExpression(expression) ? expression.expression : expression;
    if (!ast.isCallExpression(call) || !ast.isIdentifier(call.expression) || call.expression.text !== 'require') {
        return null;
    }
    const [first] = call.arguments;
    return first && ast.isStringLiteralLikeNode(first) ? first.text : null;
}

/*
 * What a local binding was made from: `const pool = new Pool()` -> `Pool`.
 *
 * Not through an `await`: what comes back from a service is data, and a
 * function that only reads the rows a query returned has not queried anything.
 */
function producingIdentifier(decl) {
    if (!ast.isVariableDeclaration(decl) || !decl.initializer) {
        return null;
    }
    if (ast.isAwaitExpression(decl.initializer)) {
        return null;
    }
    const root = rootIdentifier(decl.initializer);
    return root && root !== decl.name ? root : null;
}

const isLibSymbol = (symbol, program) =>
    Boolean(program) && declarationsOf(symbol).some(decl => program.isSourceFileDefaultLibrary(decl.getSourceFile()));

const declarationsOf = symbol => symbol.declarations.map(handle => handle.resolve()).filter(Boolean);
