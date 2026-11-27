import crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

export const fileId = relPath => `file:${relPath}`;
export const moduleId = relDir => `module:${relDir}`;
export const groupId = (relPath, name) => `group:${relPath}#${name}`;
export const functionId = (relPath, qualifiedName) => `func:${relPath}#${qualifiedName}`;
export const dataId = (relPath, name) => `data:${relPath}#${name}`;

const hashOf = text =>
    crypto
        .createHash('sha1')
        .update(
            text
                .split('\n')
                .map(line => line.replace(/\s+$/, ''))
                .join('\n')
                .trim(),
        )
        .digest('hex')
        .slice(0, 12);

export const relativePath = (rootDir, fileName) => path.relative(rootDir, fileName).split(path.sep).join('/');

const lineOf = (sourceFile, pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

/*
 * The JSDoc/leading block comment directly above a declaration, if any. The
 * README asks for a function's attached documentation to be rendered with it.
 */
function leadingDoc(node, sourceFile) {
    const fullText = sourceFile.getFullText();
    const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) || [];
    const docs = ranges.filter(range => fullText.slice(range.pos, range.pos + 3).match(/^\/\*[*!]?|^\/\//));
    if (docs.length === 0) {
        return null;
    }
    const last = docs[docs.length - 1];
    return fullText.slice(last.pos, last.end);
}

// A test file's structure lives in calls, not declarations: `describe` groups
// what `test` and the hooks do, the same way a class groups its methods.
const SUITE_CALLS = new Set(['describe', 'context', 'suite']);
const TEST_CALLS = new Set(['it', 'test', 'specify']);
const HOOK_CALLS = new Set(['before', 'beforeAll', 'beforeEach', 'after', 'afterAll', 'afterEach']);

/* `describe`, `describe.only`, `describe.each([...])` all name `describe`. */
function calledName(expression) {
    if (ts.isIdentifier(expression)) {
        return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
        return calledName(expression.expression);
    }
    if (ts.isCallExpression(expression)) {
        return calledName(expression.expression);
    }
    if (ts.isTaggedTemplateExpression(expression)) {
        return calledName(expression.tag);
    }
    return null;
}

const labelOf = call => {
    const [first] = call.arguments || [];
    if (!first) {
        return null;
    }
    if (ts.isStringLiteralLike(first)) {
        return first.text;
    }
    return null;
};

const callbackOf = call => [...(call.arguments || [])].reverse().find(argument => isFunctionLike(argument)) || null;

const isFunctionLike = node =>
    node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));

const modifierFlags = node => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : [];
    const kinds = new Set(modifiers.map(modifier => modifier.kind));
    return {
        exported: kinds.has(ts.SyntaxKind.ExportKeyword),
        isStatic: kinds.has(ts.SyntaxKind.StaticKeyword),
        isAsync: kinds.has(ts.SyntaxKind.AsyncKeyword),
    };
};

/*
 * What a caller has to know about a function: its name, its parameters, and
 * whatever type it declares. This is the part of a function that is an
 * interface; everything below it is how it does the job.
 */
function signatureOf(decl, name, sourceFile, flags) {
    const parameters = (decl.parameters || []).map(parameter => parameter.getText(sourceFile)).join(', ');
    const returns = decl.type ? `: ${decl.type.getText(sourceFile)}` : '';
    return `${flags.isAsync ? 'async ' : ''}${flags.isStatic ? 'static ' : ''}${name}(${parameters})${returns}`;
}

/*
 * The shape of a value a module binds: whether it is a structure with parts -
 * an object, an array, a Map - and what those parts are called, so that a
 * change to them can be reported as what it is.
 */
function describeValue(initializer, sourceFile) {
    if (!initializer) {
        return { shape: 'scalar', keys: null };
    }

    if (ts.isObjectLiteralExpression(initializer)) {
        return { shape: 'composite', keys: initializer.properties.map(propertyName).filter(Boolean) };
    }
    if (ts.isArrayLiteralExpression(initializer)) {
        return { shape: 'composite', keys: null };
    }
    if (ts.isNewExpression(initializer)) {
        return { shape: 'composite', keys: entryKeys(initializer, sourceFile) };
    }
    return { shape: 'scalar', keys: null };
}

const propertyName = property => {
    const name = property.name;
    if (!name) {
        return null;
    }
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return name.getText();
};

/* The keys of `new Map([['a', 1], ...])` and the members of `new Set([...])`. */
function entryKeys(expression, sourceFile) {
    const [argument] = expression.arguments || [];
    if (!argument || !ts.isArrayLiteralExpression(argument)) {
        return null;
    }

    const keys = argument.elements.map(element => {
        if (ts.isArrayLiteralExpression(element)) {
            return element.elements[0]?.getText(sourceFile) ?? null;
        }
        return element.getText(sourceFile);
    });
    return keys.every(Boolean) ? keys.map(key => key.replace(/^['"`]|['"`]$/g, '')) : null;
}

const memberName = member => {
    if (ts.isConstructorDeclaration(member)) {
        return 'constructor';
    }
    if (!member.name) {
        return null;
    }
    if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
        return member.name.text;
    }
    if (ts.isComputedPropertyName(member.name)) {
        return member.name.getText();
    }
    return null;
};

/*
 * Collects the graph's leaf nodes (functions) and their class/interface groups
 * from a set of source files.
 *
 * Returns:
 *   nodes              - serialisable file/group/function nodes
 *   functionDecls      - [{ id, decl }] used to walk bodies for call edges
 *   idByDeclaration    - Map of AST declaration node -> graph node id, used to
 *                        resolve a call's target symbol back to a graph node
 *   dataByDeclaration  - the same for data nodes, kept apart because data is
 *                        not a call target (see `collectVariableDeclaration`)
 *                        but is what a read or a write reaches
 *   typeIdByDeclaration- declaration -> id for the type-like nodes only, which
 *                        is what a carried type resolves against
 *   sourceAnchors      - [{ id, anchor }]: the AST node each function's or
 *                        data node's `code` is the text of, which is what the
 *                        names in that code are read off
 */
export function collectDeclarations(sourceFiles, rootDir) {
    const nodes = [];
    const functionDecls = [];
    const idByDeclaration = new Map();
    const dataByDeclaration = new Map();
    const typeIdByDeclaration = new Map();
    const sourceAnchors = [];

    for (const sourceFile of sourceFiles) {
        collectFile(sourceFile, relativePath(rootDir, sourceFile.fileName), {
            nodes,
            functionDecls,
            idByDeclaration,
            dataByDeclaration,
            typeIdByDeclaration,
            sourceAnchors,
        });
    }

    // A class or an interface is both a call target and a type; the group
    // entries already collected are exactly its type identity.
    for (const [decl, id] of idByDeclaration) {
        if (id.startsWith('group:')) {
            typeIdByDeclaration.set(decl, id);
        }
    }

    return { nodes, functionDecls, idByDeclaration, dataByDeclaration, typeIdByDeclaration, sourceAnchors };
}

function collectFile(sourceFile, relPath, sink) {
    sink.nodes.push({
        id: fileId(relPath),
        kind: 'file',
        name: path.basename(relPath),
        parent: path.dirname(relPath) === '.' ? null : moduleId(path.dirname(relPath)),
        file: relPath,
        line: 1,
    });

    for (const statement of sourceFile.statements) {
        collectStatement(statement, { sourceFile, relPath, sink });
    }
}

function collectStatement(statement, context) {
    const { relPath } = context;

    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
        collectGroup(statement, statement.name?.text || 'default', context);
        return;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
        addData(statement, statement.name.text, 'type', context);
        return;
    }

    if (ts.isEnumDeclaration(statement)) {
        addData(statement, statement.name.text, 'enum', context);
        return;
    }

    if (ts.isFunctionDeclaration(statement)) {
        const name = statement.name?.text || 'default';
        addFunction(statement, name, fileId(relPath), context);
        return;
    }

    if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
            collectVariableDeclaration(declaration, statement, context);
        }
        return;
    }

    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        collectTestCall(statement.expression, context, fileId(relPath), []);
        return;
    }

    if (ts.isExportAssignment(statement) && isFunctionLike(statement.expression)) {
        addFunction(statement.expression, 'default', fileId(relPath), context, statement);
        return;
    }

    // `export default class/function ...` arrives as a declaration with an
    // export modifier and is handled above; anything else has no graph node.
    if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body)) {
        for (const inner of statement.body.statements) {
            collectStatement(inner, context);
        }
    }
}

function collectVariableDeclaration(declaration, statement, context) {
    const { relPath, sink } = context;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        return;
    }
    const name = declaration.name.text;

    if (ts.isClassExpression(declaration.initializer)) {
        collectGroup(declaration.initializer, name, context, statement);
        sink.idByDeclaration.set(declaration, groupId(relPath, name));
        return;
    }

    if (isFunctionLike(declaration.initializer)) {
        const id = addFunction(declaration.initializer, name, fileId(relPath), context, statement);
        sink.idByDeclaration.set(declaration, id);
        sink.idByDeclaration.set(declaration.name, id);
        return;
    }

    // Anything else a module declares at its top level is data: a table, a
    // configuration object, a threshold. Not registered as a call target - a
    // call reaching into one lands on whatever it holds, not on the binding.
    addData(declaration, name, 'constant', context, {
        docAnchor: statement,
        initializer: declaration.initializer,
    });
}

function collectGroup(node, name, context, docAnchor = null) {
    const { sourceFile, relPath, sink } = context;
    const id = groupId(relPath, name);
    const kindLabel = ts.isInterfaceDeclaration(node) ? 'interface' : 'class';

    sink.nodes.push({
        id,
        kind: 'group',
        groupKind: kindLabel,
        name,
        parent: fileId(relPath),
        file: relPath,
        line: lineOf(sourceFile, node.getStart(sourceFile)),
        endLine: lineOf(sourceFile, node.getEnd()),
        doc: leadingDoc(docAnchor || node, sourceFile),
        extends: node.heritageClauses?.map(clause => clause.getText()).join(' ') || null,
        ...modifierFlags(docAnchor || node),
    });
    sink.idByDeclaration.set(node, id);
    if (node.name) {
        sink.idByDeclaration.set(node.name, id);
    }

    for (const member of node.members) {
        const memberIdName = memberName(member);
        if (!memberIdName) {
            continue;
        }
        const qualified = `${name}.${memberIdName}`;

        if (
            ts.isMethodDeclaration(member) ||
            ts.isConstructorDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member) ||
            ts.isMethodSignature(member)
        ) {
            addFunction(member, qualified, id, context);
        } else if (ts.isPropertyDeclaration(member) && isFunctionLike(member.initializer)) {
            addFunction(member.initializer, qualified, id, context, member);
            sink.idByDeclaration.set(member, functionId(relPath, qualified));
        } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
            // A field is part of the shape of the thing that declares it.
            addData(member, qualified, 'field', context, { parentId: id, initializer: member.initializer });
        }
    }
}

/*
 * A suite becomes a group and the tests inside it become its members, so a test
 * file reads on the canvas the way its source reads - and what a test calls
 * becomes an edge into the code it exercises.
 */
function collectTestCall(call, context, parentId, trail) {
    const { sourceFile, relPath, sink } = context;
    const name = calledName(call.expression);
    const label = labelOf(call);
    const body = callbackOf(call);
    if (!name || !body) {
        return;
    }

    if (SUITE_CALLS.has(name) && label) {
        const path = [...trail, label];
        const id = groupId(relPath, path.join(' › '));
        sink.nodes.push({
            id,
            kind: 'group',
            groupKind: 'suite',
            name: label,
            parent: parentId,
            file: relPath,
            line: lineOf(sourceFile, call.getStart(sourceFile)),
            endLine: lineOf(sourceFile, call.getEnd()),
            doc: leadingDoc(call.parent, sourceFile),
        });

        for (const statement of body.body?.statements || []) {
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
                collectTestCall(statement.expression, context, id, path);
            }
        }
        return;
    }

    if (TEST_CALLS.has(name) || HOOK_CALLS.has(name)) {
        addTest(call, body, HOOK_CALLS.has(name) ? name : label || name, {
            role: HOOK_CALLS.has(name) ? 'hook' : 'test',
            parentId,
            trail,
            context,
        });
    }
}

function addTest(call, body, label, { role, parentId, trail, context }) {
    const { sourceFile, relPath, sink } = context;
    const qualifiedName = [...trail, label].join(' › ');
    const id = functionId(relPath, qualifiedName);
    const code = call.parent.getText(sourceFile);

    sink.nodes.push({
        id,
        kind: 'function',
        role,
        name: label,
        qualifiedName,
        parent: parentId,
        file: relPath,
        line: lineOf(sourceFile, call.getStart(sourceFile)),
        endLine: lineOf(sourceFile, call.getEnd()),
        doc: leadingDoc(call.parent, sourceFile),
        code,
        hash: hashOf(code),
        exported: false,
        isStatic: false,
        isAsync: Boolean(body.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
    });

    // Its body is walked for calls like any other function's.
    sink.functionDecls.push({ id, decl: body });
    sink.sourceAnchors.push({ id, anchor: call.parent });
}

/*
 * Registers one data node: a type, an enum, or a top-level binding that is not
 * a function. These have source and documentation like a function, and diff the
 * same way, but they call nothing and nothing calls them.
 */
function addData(decl, name, dataKind, context, { docAnchor = null, parentId = null, initializer = null } = {}) {
    const { sourceFile, relPath, sink } = context;
    const anchor = docAnchor || decl;
    const doc = leadingDoc(anchor, sourceFile);
    const code = anchor.getText(sourceFile);
    const { shape, keys } = describeValue(initializer, sourceFile);

    const id = dataId(relPath, name);
    sink.nodes.push({
        id,
        kind: 'data',
        dataKind,
        shape,
        keys,
        name,
        parent: parentId || fileId(relPath),
        file: relPath,
        line: lineOf(sourceFile, anchor.getStart(sourceFile)),
        endLine: lineOf(sourceFile, decl.getEnd()),
        doc,
        code,
        hash: hashOf(`${doc || ''}\n${code}`),
        ...modifierFlags(anchor),
    });

    sink.sourceAnchors.push({ id, anchor });
    sink.dataByDeclaration.set(decl, id);
    if (decl.name) {
        sink.dataByDeclaration.set(decl.name, id);
    }
    if (dataKind === 'type' || dataKind === 'enum') {
        sink.typeIdByDeclaration.set(decl, id);
    }
}

/*
 * Registers one function node. `docAnchor` is the statement that carries the
 * leading documentation when the function itself is an initialiser (e.g.
 * `export const f = () => {}`).
 */
function addFunction(decl, qualifiedName, parentId, context, docAnchor = null) {
    const { sourceFile, relPath, sink } = context;
    const id = functionId(relPath, qualifiedName);
    const anchor = docAnchor || decl;
    const doc = leadingDoc(anchor, sourceFile);
    const code = anchor.getText(sourceFile);

    const flags = modifierFlags(anchor);
    const shortName = qualifiedName.includes('.') ? qualifiedName.split('.').slice(1).join('.') : qualifiedName;

    sink.nodes.push({
        id,
        kind: 'function',
        name: shortName,
        qualifiedName,
        signature: signatureOf(decl, shortName, sourceFile, flags),
        parent: parentId,
        file: relPath,
        line: lineOf(sourceFile, anchor.getStart(sourceFile)),
        endLine: lineOf(sourceFile, decl.getEnd()),
        doc,
        code,
        hash: hashOf(`${doc || ''}\n${code}`),
        ...flags,
    });

    sink.functionDecls.push({ id, decl });
    sink.sourceAnchors.push({ id, anchor });
    sink.idByDeclaration.set(decl, id);
    if (decl.name) {
        sink.idByDeclaration.set(decl.name, id);
    }
    if (docAnchor) {
        sink.idByDeclaration.set(docAnchor, id);
    }
    return id;
}
