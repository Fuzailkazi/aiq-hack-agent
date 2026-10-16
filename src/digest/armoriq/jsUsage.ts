/** Find ArmorIQ SDK imports and calls in JS/TS (tree-sitter: comments and strings never count). */
import type { UsageSite } from "../../schemas/evidence";
import { snippetAt } from "./files";
import type { ScanResult } from "./pythonUsage";
import type { SecretRedactor } from "./secrets";
import { allNodes, type Grammar, type Node, named, parse } from "./treeSitter";

export const JS_SUFFIXES: Record<string, Grammar> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
};
/** Files whose <script> blocks hold JS/TS: single-file components, and plain HTML pages. */
export const SFC_SUFFIXES = new Set([".vue", ".svelte", ".astro", ".html", ".htm"]);
const JS_SCRIPT_TYPES = /^(module|text\/javascript|application\/javascript|text\/babel|text\/typescript)$/i;

/** A bare specifier ("@armoriq/sdk", "@armoriq/sdk/x") or a CDN URL for the package (esm.sh, jsdelivr, unpkg). */
export function isSdkSpecifier(spec: string, modules: string[]): boolean {
  if (modules.some((m) => spec === m || spec.startsWith(`${m}/`))) return true;
  if (!/^https?:\/\//i.test(spec)) return false;
  return modules.some((m) =>
    new RegExp(`/${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[@/?#]|$)`).test(spec),
  );
}
const DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

const stringValue = (node: Node | null | undefined): string | null =>
  node && (node.type === "string" || node.type === "template_string") ? node.text.slice(1, -1) : null;

function unwrap(node: Node): Node {
  let current = node;
  while (
    (current.type === "await_expression" || current.type === "parenthesized_expression") &&
    named(current).length
  ) {
    current = named(current)[0];
  }
  return current;
}

/** Dotted callee of a call/new expression (`client.invoke`, `this.c.invoke`), or null if not a plain chain. */
function callee(node: Node): string | null {
  const fn =
    node.type === "call_expression"
      ? node.childForFieldName("function")
      : node.type === "new_expression"
        ? node.childForFieldName("constructor")
        : null;
  if (!fn) return null;
  const text = fn.text.replaceAll("?.", ".");
  return DOTTED.test(text) ? text : null;
}

/** For `new X().m()` / `(await X.create()).m()`: [inner callee, method]. */
function chainedCall(node: Node): [string, string] | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const object = fn.childForFieldName("object");
  const property = fn.childForFieldName("property");
  if (!object || !property) return null;
  const inner = callee(unwrap(object));
  return inner ? [inner, property.text] : null;
}

export function scanJs(
  rel: string,
  source: string,
  suffix: string,
  modules: string[],
  inTest: boolean,
  redactor: SecretRedactor,
): ScanResult {
  const tree = parse(JS_SUFFIXES[suffix], source);
  try {
    const lines = source.split("\n");
    const nodes = allNodes(tree.rootNode);
    const isSdk = (spec: string | null): spec is string => spec !== null && isSdkSpecifier(spec, modules);
    const bindings = new Map<string, string>(); // local name -> imported name ("*" for a namespace/require object)
    const instances = new Set<string>();
    const sites: UsageSite[] = [];
    const unresolved: string[] = [];
    const site = (node: Node, symbol: string, kind: UsageSite["kind"], typeOnly = false) => {
      const line = node.startPosition.row + 1;
      sites.push({
        path: rel,
        line,
        symbol,
        kind,
        snippet: snippetAt(lines, line, redactor),
        inTest,
        typeOnly,
      });
    };

    for (const n of nodes) {
      if (n.type === "import_statement") {
        const requireClause = named(n).find((c) => c.type === "import_require_clause");
        if (requireClause) {
          // TS: import sdk = require('@armoriq/sdk')
          const spec = stringValue(requireClause.childForFieldName("source"));
          if (!isSdk(spec)) continue;
          const ident = named(requireClause).find((c) => c.type === "identifier");
          if (ident) bindings.set(ident.text, "*");
          site(n, spec, "import");
          continue;
        }
        const spec = stringValue(n.childForFieldName("source"));
        if (!isSdk(spec)) continue;
        const typeOnly = n.text.trimStart().startsWith("import type");
        if (!typeOnly) bindImportClause(n, bindings);
        site(n, spec, "import", typeOnly);
      } else if (n.type === "export_statement" && n.childForFieldName("source")) {
        const spec = stringValue(n.childForFieldName("source"));
        if (isSdk(spec)) unresolved.push(`re-export of ${spec} in ${rel}:${n.startPosition.row + 1}`);
      } else if (n.type === "call_expression") {
        const fn = n.childForFieldName("function");
        const args = n.childForFieldName("arguments");
        const spec = stringValue(args ? named(args)[0] : null);
        if (!fn || !isSdk(spec)) continue;
        if (fn.type === "import")
          unresolved.push(`dynamic import of ${spec} in ${rel}:${n.startPosition.row + 1}`);
        else if (fn.type === "identifier" && fn.text === "require") {
          bindRequire(n, bindings);
          site(n, spec, "import");
        }
      }
    }

    for (const n of nodes) {
      const [target, value] =
        n.type === "variable_declarator"
          ? [n.childForFieldName("name"), n.childForFieldName("value")]
          : n.type === "assignment_expression"
            ? [n.childForFieldName("left"), n.childForFieldName("right")]
            : [null, null];
      if (!target || !value) continue;
      const created = callee(unwrap(value));
      if (created && bindings.has(created.split(".")[0]) && DOTTED.test(target.text))
        instances.add(target.text);
    }
    const fromSdk = (name: string): boolean =>
      bindings.has(name.split(".")[0]) || [...instances].some((i) => name === i || name.startsWith(`${i}.`));

    for (const n of nodes) {
      if (n.type !== "call_expression" && n.type !== "new_expression") continue;
      const name = callee(n);
      if (name === null) {
        const chained = chainedCall(n);
        if (chained && fromSdk(chained[0])) site(n, chained[1], "call");
        continue;
      }
      const parts = name.split(".");
      const base = bindings.get(parts[0]);
      if (base !== undefined) {
        const symbol =
          parts.length > 1 || base === "*" || base === "default" ? (parts.at(-1) as string) : base;
        site(n, symbol, n.type === "new_expression" || /^[A-Z]/.test(symbol) ? "client_init" : "call");
      } else if ([...instances].some((i) => name.startsWith(`${i}.`))) {
        site(n, parts.at(-1) as string, "call");
      }
    }
    // Syntax errors (merge-conflict markers, a broken template) can hide real usage from the tree: never let that
    // read as positive absence.
    if (tree.rootNode.hasError && modules.some((m) => source.includes(m))) {
      unresolved.push(`unparseable JS/TS file mentions the ArmorIQ SDK: ${rel}`);
    }
    sites.sort((a, b) => a.line - b.line);
    return { sites, unresolved };
  } finally {
    tree.delete();
  }
}

/** Scan <script> blocks of Vue/Svelte/Astro single-file components (plus Astro frontmatter). */
export function scanSfc(
  rel: string,
  source: string,
  suffix: string,
  modules: string[],
  inTest: boolean,
  redactor: SecretRedactor,
): ScanResult {
  const blocks: [number, string, string][] = []; // [offset, code, parser suffix]
  const front = suffix === ".astro" ? FRONTMATTER.exec(source) : null;
  if (front) blocks.push([source.indexOf(front[1]), front[1], ".ts"]);
  for (const m of source.matchAll(SCRIPT_BLOCK)) {
    const type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1];
    if (type && !JS_SCRIPT_TYPES.test(type)) continue; // JSON-LD, templates, importmaps
    const lang = /lang\s*=\s*["']?(tsx|ts|typescript)/i.exec(m[1]);
    blocks.push([
      (m.index ?? 0) + m[0].indexOf(m[2]),
      m[2],
      lang ? (lang[1] === "tsx" ? ".tsx" : ".ts") : ".js",
    ]);
  }
  const result: ScanResult = { sites: [], unresolved: [] };
  for (const [offset, code, parserSuffix] of blocks) {
    // Pad with newlines so line numbers match the original file.
    const padded = "\n".repeat(source.slice(0, offset).split("\n").length - 1) + code;
    const r = scanJs(rel, padded, parserSuffix, modules, inTest, redactor);
    result.sites.push(...r.sites);
    result.unresolved.push(...r.unresolved);
  }
  return result;
}

function bindImportClause(stmt: Node, bindings: Map<string, string>): void {
  for (const clause of named(stmt).filter((c) => c.type === "import_clause")) {
    for (const child of named(clause)) {
      if (child.type === "identifier") bindings.set(child.text, "default");
      else if (child.type === "namespace_import")
        for (const ident of named(child)) bindings.set(ident.text, "*");
      else if (child.type === "named_imports") {
        for (const spec of named(child).filter((s) => s.type === "import_specifier")) {
          const name = spec.childForFieldName("name");
          const alias = spec.childForFieldName("alias");
          if (name) bindings.set((alias ?? name).text, name.text);
        }
      }
    }
  }
}

function bindRequire(call: Node, bindings: Map<string, string>): void {
  let parent = call.parent;
  while (parent && (parent.type === "await_expression" || parent.type === "parenthesized_expression"))
    parent = parent.parent;
  let member: string | null = null; // const Client = require('@armoriq/sdk').ArmorIQClient
  if (parent?.type === "member_expression") {
    member = parent.childForFieldName("property")?.text ?? null;
    parent = parent.parent;
  }
  if (parent?.type !== "variable_declarator") return;
  const name = parent.childForFieldName("name");
  if (!name) return;
  if (name.type === "identifier") bindings.set(name.text, member ?? "*");
  else if (name.type === "object_pattern") {
    for (const prop of named(name)) {
      if (prop.type === "shorthand_property_identifier_pattern") bindings.set(prop.text, prop.text);
      else if (prop.type === "pair_pattern") {
        const key = prop.childForFieldName("key");
        const value = prop.childForFieldName("value");
        if (key && value) bindings.set(value.text, key.text);
      }
    }
  }
}
