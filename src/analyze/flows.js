import ts from 'typescript';
import { packageNameOf } from '#srcblocks/analyze/externals.js';

/*
 * What flows: the types a call carries in and out, the members a type declares,
 * and the module-level data a function reads or writes.
 *
 * A call edge says that A calls B. That is the shape of the program, not what
 * it does with it. The same edge annotated with `Order` in and `Order` out says
 * what travels along it, which is the question a reader following a piece of
 * data through unfamiliar code is actually asking.
 */

export const accessEdgeId = (source, target) => `access:${source}->${target}`;

/* Caps: a label nobody can read is worse than a truncated one. */
const MAX_UNION = 4;
const MAX_IN = 8;
const MAX_OUT = 4;
const MAX_ANONYMOUS_MEMBERS = 40;
const MAX_NODE_MEMBERS = 60;

const PRIMITIVE_FLAGS =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Void |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Never;

const UNTYPED_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

const ANONYMOUS_SYMBOL_NAMES = new Set(['__type', '__object']);

/*
 * Normalises a checker type into the flat references a label can be built from.
 *
 * `text` is what the type is called on screen. Wrappers are treated
 * differently on purpose: `Promise<Order>` becomes `Order`, because whether a
 * value arrives now or later is not what the reader is following, while
 * `Order[]` stays `Order[]`, because one order and many orders are different
 * things. Both still point their `ref` at `Order`, so the same type is the same
 * node wherever it travels.
 */
export function typeRefsOf(type, checker, options = {}) {
    if (!type) {
        return [];
    }

    const unwrapped = unwrapPromise(type, checker);
    // A union with a name of its own is one thing to the reader: `Status`, not
    // `'open' | 'paid'`.
    if (declarationRef(unwrapped, options.typeIdByDeclaration).id) {
        return [referenceTo(unwrapped, checker, options)];
    }

    const parts = unionConstituents(unwrapped);
    if (!parts) {
        return [referenceTo(unwrapped, checker, options)];
    }

    return dedupeRefs(parts.map(part => referenceTo(part, checker, options))).slice(0, MAX_UNION);
}

/* Two references to the same type are one reference; anonymous ones go by text. */
export function dedupeRefs(refs) {
    const seen = new Map();
    for (const ref of refs) {
        const key = ref.ref || ref.text;
        if (!seen.has(key)) {
            seen.set(key, ref);
        }
    }
    return [...seen.values()];
}

/*
 * A reference is untyped when the checker had nothing to say about it. A call
 * whose every reference is untyped is a call whose flow is unknown - worth
 * marking, since that is a gap in the picture rather than a fact about it.
 */
const allUntyped = refs => refs.length > 0 && refs.every(ref => ref.untyped);

function unwrapPromise(type, checker) {
    const name = type.aliasSymbol?.name || type.symbol?.name;
    if (name !== 'Promise') {
        return type;
    }
    return checker.getAwaitedType?.(type) || type;
}

/*
 * The constituents of a union worth showing separately, or null when the type
 * is not one. `boolean` is a union of two literals and an enum is a union of
 * its members; both read as one thing, so neither is expanded. An absent value
 * (`Order | null`) is not a second kind of thing either.
 */
function unionConstituents(type) {
    if (!(type.flags & ts.TypeFlags.Union)) {
        return null;
    }
    if (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.EnumLike)) {
        return null;
    }

    const present = type.types.filter(part => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    return present.length ? present : type.types.slice(0, 1);
}

function referenceTo(type, checker, options) {
    const text = safeText(type, checker);

    if (type.flags & UNTYPED_FLAGS) {
        return { ref: null, text, external: false, untyped: true };
    }
    if (isPrimitive(type)) {
        return { ref: null, text, external: 'lib', primitive: true };
    }

    if (isArray(type, checker)) {
        const [element] = checker.getTypeArguments(type) || [];
        // The element decides identity, the array decides how it reads. Many of
        // a thing is not one of that thing, so `string[]` is not a primitive.
        if (element) {
            const { primitive, ...inner } = referenceTo(element, checker, options);
            return { ...inner, text };
        }
    }

    const { id, decl } = declarationRef(type, options.typeIdByDeclaration);
    const external = externalityOf(type, decl, options.program);
    const reference = { ref: id, text, external };

    if (!id && isAnonymousObject(type)) {
        reference.members = membersOfType(type, checker, MAX_ANONYMOUS_MEMBERS, decl);
    }
    return reference;
}

/*
 * Where the type came from: a type alias used as a type keeps its name on
 * `aliasSymbol` and an anonymous shape on `symbol`, so the alias is tried
 * first - `Status` is what the reader wrote.
 */
function declarationRef(type, typeIdByDeclaration) {
    const candidates = [...(type.aliasSymbol?.declarations || []), ...(type.symbol?.declarations || [])];
    for (const decl of candidates) {
        const id = typeIdByDeclaration?.get(decl);
        if (id) {
            return { id, decl };
        }
    }
    return { id: null, decl: candidates[0] || null };
}

/*
 * Whether the type belongs to this program or comes from outside it. A type
 * parameter belongs to neither - it stands for whatever the caller passes - and
 * is reported as `lib` so that it is never mistaken for a type of this program.
 */
function externalityOf(type, decl, program) {
    if (type.flags & ts.TypeFlags.TypeParameter) {
        return 'lib';
    }
    if (!decl) {
        return false;
    }

    const sourceFile = decl.getSourceFile?.();
    if (!sourceFile) {
        return false;
    }
    if (program?.isSourceFileDefaultLibrary(sourceFile)) {
        return 'lib';
    }
    return packageFromPath(sourceFile.fileName) || false;
}

/* `.../node_modules/@scope/name/dist/index.d.ts` -> `@scope/name`. */
export function packageFromPath(fileName) {
    const marker = fileName.lastIndexOf('/node_modules/');
    if (marker === -1) {
        return null;
    }
    const rest = fileName.slice(marker + '/node_modules/'.length);
    return rest ? packageNameOf(rest) : null;
}

const isPrimitive = type => Boolean(type.flags & PRIMITIVE_FLAGS) && !(type.flags & ts.TypeFlags.EnumLike);

const isArray = (type, checker) =>
    typeof checker.isArrayType === 'function' ? checker.isArrayType(type) : type.symbol?.name === 'Array';

const isAnonymousObject = type =>
    Boolean(type.flags & ts.TypeFlags.Object) && (!type.symbol || ANONYMOUS_SYMBOL_NAMES.has(type.symbol.name));

function safeText(type, checker) {
    try {
        return checker.typeToString(type);
    } catch {
        return 'unknown';
    }
}

function membersOfType(type, checker, cap, anchor) {
    let properties;
    try {
        properties = checker.getPropertiesOfType(type) || [];
    } catch {
        return [];
    }
    return properties.slice(0, cap).map(property => ({
        name: property.getName(),
        type: memberTypeText(property, checker, anchor),
    }));
}

function memberTypeText(property, checker, anchor) {
    const node = property.valueDeclaration || property.declarations?.[0] || anchor;
    try {
        return checker.typeToString(checker.getTypeOfSymbolAtLocation(property, node));
    } catch {
        return 'unknown';
    }
}

/*
 * Annotates every call edge with what its call sites carry.
 *
 * Argument types are read where the arguments are written, not off the callee's
 * declaration: what a caller actually hands over is the fact of interest, and a
 * parameter declared `Order` may be given `Order | null`.
 */
export function attachCarries(edges, sitesByEdge, checker, options = {}) {
    for (const edge of edges) {
        const incoming = [];
        const outgoing = [];

        for (const call of sitesByEdge.get(edge.id) || []) {
            // The checker throws on some broken code; a site it cannot read
            // simply carries nothing.
            try {
                for (const argument of call.arguments || []) {
                    incoming.push(...typeRefsOf(checker.getTypeAtLocation(argument), checker, options));
                }
                outgoing.push(...typeRefsOf(returnTypeOf(call, checker), checker, options));
            } catch {
                continue;
            }
        }

        edge.carries = carriesFrom(incoming, outgoing);
    }
    return edges;
}

/* `new Foo()` returns the instance it constructs, which the signature knows. */
function returnTypeOf(call, checker) {
    const signature = checker.getResolvedSignature(call);
    return signature ? signature.getReturnType() : checker.getTypeAtLocation(call);
}

function carriesFrom(incoming, outgoing) {
    const inRefs = dedupeRefs(incoming).slice(0, MAX_IN);
    const outRefs = dedupeRefs(outgoing).slice(0, MAX_OUT);
    return { in: inRefs, out: outRefs, untyped: allUntyped([...inRefs, ...outRefs]) };
}

/*
 * Records the members of every type-like node: the fields of a class or
 * interface, the shape of a type alias, the cases of an enum.
 *
 * A data node already carries its source; its members are that source read as
 * a shape, so that what a call carries can be opened up without going to the
 * file it was declared in.
 */
export function attachMembers(nodes, typeIdByDeclaration, checker) {
    const declById = declarationsById(typeIdByDeclaration);

    for (const node of nodes) {
        if (!isTypeLike(node)) {
            continue;
        }
        const decl = declById.get(node.id);
        if (!decl) {
            continue;
        }

        const members = declaredMembers(decl, checker);
        if (members.length) {
            node.members = members;
        }
    }
    return nodes;
}

const isTypeLike = node =>
    (node.kind === 'data' && (node.dataKind === 'type' || node.dataKind === 'enum')) ||
    (node.kind === 'group' && (node.groupKind === 'class' || node.groupKind === 'interface'));

/*
 * The map runs declaration -> id and holds both a declaration and its name
 * node; only the declaration itself can be asked for its members.
 */
function declarationsById(typeIdByDeclaration) {
    const byId = new Map();
    for (const [decl, id] of typeIdByDeclaration || []) {
        if (ts.isIdentifier(decl)) {
            continue;
        }
        if (!byId.has(id)) {
            byId.set(id, decl);
        }
    }
    return byId;
}

function declaredMembers(decl, checker) {
    const symbol = decl.name ? checker.getSymbolAtLocation(decl.name) : checker.getSymbolAtLocation(decl);
    if (symbol) {
        const declared = checker.getDeclaredTypeOfSymbol(symbol);
        // Only a type that is a shape has members. `type Status = 'open' |
        // 'paid'` would otherwise report everything a string can do.
        if (declared.flags & ts.TypeFlags.Object) {
            // A class's declared type is its instance side, which is the shape
            // a caller holding one sees.
            const members = membersOfType(declared, checker, MAX_NODE_MEMBERS, decl);
            if (members.length) {
                return members;
            }
        }
    }

    // An enum's declared type is the union of its members, which has no
    // properties of its own; the declaration says what the cases are called.
    if (ts.isEnumDeclaration(decl)) {
        return decl.members.slice(0, MAX_NODE_MEMBERS).map(member => ({
            name: member.name.getText(),
            type: member.initializer ? member.initializer.getText() : 'number',
        }));
    }
    return [];
}

/*
 * Resolves what every function reads and writes of the data the program
 * declares, producing the access edges of the graph.
 *
 * Every module-level constant qualifies, in its own file as much as in another
 * one: a constant is a declaration like any other, and the reader asking what
 * a table or a threshold is for is asking what reaches it. What that costs is
 * paid where it shows - flows mode draws movement between boxes, so a read
 * inside one box collapses away there, while the calls view draws it as the
 * edge it is.
 */
export function resolveAccesses({ nodes, functionDecls, dataByDeclaration }, checker, options = {}) {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const found = new Map();

    for (const { id: sourceId, decl } of functionDecls) {
        const fn = nodeById.get(sourceId);
        if (!fn) {
            continue;
        }

        visitIdentifiers(decl.body || decl, identifier => {
            const targetId = dataTargetOf(identifier, checker, dataByDeclaration);
            if (!targetId) {
                return;
            }

            const data = nodeById.get(targetId);
            if (!data || data.dataKind !== 'constant') {
                return;
            }

            recordAccess(found, sourceId, targetId, identifier, checker, options);
        });
    }

    return [...found.values()].map(accessEdge);
}

function recordAccess(found, source, target, identifier, checker, options) {
    const id = accessEdgeId(source, target);
    const sourceFile = identifier.getSourceFile();
    const existing = found.get(id) || {
        id,
        source,
        target,
        callCount: 0,
        line: sourceFile.getLineAndCharacterOfPosition(identifier.getStart(sourceFile)).line + 1,
        modes: new Set(),
        reads: [],
        writes: [],
    };

    const write = isWritePosition(identifier);
    existing.callCount += 1;
    existing.modes.add(write ? 'write' : 'read');
    try {
        const refs = typeRefsOf(checker.getTypeAtLocation(identifier), checker, options);
        (write ? existing.writes : existing.reads).push(...refs);
    } catch {
        // Nothing to say about this site's type.
    }

    found.set(id, existing);
}

/*
 * A read carries the value out of the binding and into the function, a write
 * carries it the other way, so the same two fields say it for accesses as for
 * calls. A function that does both is one edge, marked 'both'.
 */
function accessEdge({ id, source, target, callCount, line, modes, reads, writes }) {
    const mode = modes.size > 1 ? 'both' : [...modes][0];
    return {
        id,
        source,
        target,
        kind: 'access',
        mode,
        callCount,
        line,
        carries: carriesFrom(writes, reads),
    };
}

function visitIdentifiers(node, onIdentifier) {
    const visit = current => {
        if (ts.isIdentifier(current) && isReference(current)) {
            onIdentifier(current);
        }
        ts.forEachChild(current, visit);
    };
    visit(node);
}

/*
 * Whether an identifier stands for a value being used. A name being declared,
 * the property half of `a.b`, an import's specifier and the callee of a call
 * are all identifiers too, and none of them is a read of a binding - a call is
 * already a call edge.
 */
function isReference(identifier) {
    const parent = identifier.parent;
    if (!parent) {
        return false;
    }
    if (parent.name === identifier || parent.propertyName === identifier) {
        return false;
    }
    if (ts.isQualifiedName(parent) && parent.right === identifier) {
        return false;
    }
    if (
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportEqualsDeclaration(parent)
    ) {
        return false;
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === identifier) {
        return false;
    }
    return true;
}

function dataTargetOf(identifier, checker, dataByDeclaration) {
    if (!dataByDeclaration) {
        return null;
    }

    let symbol = checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        try {
            symbol = checker.getAliasedSymbol(symbol);
        } catch {
            // Unresolvable alias; keep the local symbol.
        }
    }

    for (const decl of symbol?.declarations || []) {
        const id = dataByDeclaration.get(decl);
        if (id) {
            return id;
        }
    }
    return null;
}

/*
 * Writes are recognised by position: the binding is the root of an assignment's
 * left-hand side (`x = 1`, `x.a = 1`, `x[k] = 1`, `x += 1`) or the operand of
 * an increment. Everything else is a read.
 */
function isWritePosition(identifier) {
    let current = identifier;
    let parent = current.parent;
    while (
        parent &&
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current
    ) {
        current = parent;
        parent = current.parent;
    }
    if (!parent) {
        return false;
    }

    if (ts.isBinaryExpression(parent) && parent.left === current) {
        const kind = parent.operatorToken.kind;
        return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
    }
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === current) {
        return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
    }
    return false;
}

/* Edge counts for the status line: how much of the flow is actually known. */
export function flowStats(edges) {
    const stats = { typed: 0, untyped: 0, access: 0 };
    for (const edge of edges) {
        if (edge.kind === 'access') {
            stats.access += 1;
        }
        const carries = edge.carries;
        if (!carries) {
            continue;
        }
        const refs = carries.in.length + carries.out.length;
        if (carries.untyped) {
            stats.untyped += 1;
        } else if (refs > 0) {
            stats.typed += 1;
        }
    }
    return stats;
}
