/** Find ArmorIQ SDK imports and calls in Python source (tree-sitter: comments and strings never count). */
import type { UsageSite } from "../../schemas/evidence";
import { snippetAt } from "./files";
import { notebookSource } from "./installs";
import type { SecretRedactor } from "./secrets";
import { allNodes, type Node, named, parse } from "./treeSitter";

export interface ScanResult {
  sites: UsageSite[];
  unresolved: string[];
}

const DYNAMIC_IMPORTERS = new Set(["importlib.import_module", "import_module", "__import__"]);
const isSdk = (module: string, modules: string[]): boolean =>
  modules.some((m) => module === m || module.startsWith(`${m}.`));

/** `a`, `a.b.c` for identifier/attribute chains; null for anything else (calls, subscripts, ...). */
function dotted(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    const base = dotted(node.childForFieldName("object"));
    const attr = node.childForFieldName("attribute");
    return base && attr ? `${base}.${attr.text}` : null;
  }
  return null;
}

/** Strip `( ... )` and `await` wrappers. */
function unwrap(node: Node): Node {
  let current = node;
  while ((current.type === "parenthesized_expression" || current.type === "await") && named(current).length) {
    current = named(current)[0];
  }
  return current;
}

function stringLiteral(node: Node | undefined): string | null {
  if (node?.type !== "string") return null;
  const content = named(node).find((c) => c.type === "string_content");
  return content ? content.text : "";
}

export function scanPython(
  rel: string,
  rawSource: string,
  modules: string[],
  inTest: boolean,
  redactor: SecretRedactor,
): ScanResult {
  const source = rawSource.replace(/^﻿/, "");
  const tree = parse("python", source);
  try {
    const lines = source.split("\n");
    const nodes = allNodes(tree.rootNode);
    const bindings = new Map<string, string>(); // local name -> qualified SDK name
    const sites: UsageSite[] = [];
    const unresolved: string[] = [];
    const site = (node: Node, symbol: string, kind: UsageSite["kind"]) => {
      const line = node.startPosition.row + 1;
      sites.push({
        path: rel,
        line,
        symbol,
        kind,
        snippet: snippetAt(lines, line, redactor),
        inTest,
        typeOnly: false,
      });
    };
    const qualify = (name: string): string => {
      const [root, ...rest] = name.split(".");
      return [bindings.get(root) ?? root, ...rest].join(".");
    };

    for (const node of nodes) {
      if (node.type === "import_statement") {
        for (const child of node.childrenForFieldName("name").filter((c): c is Node => c !== null)) {
          const isAlias = child.type === "aliased_import";
          const module = (isAlias ? child.childForFieldName("name") : child)?.text ?? "";
          if (!isSdk(module, modules)) continue;
          const alias = isAlias ? child.childForFieldName("alias")?.text : undefined;
          bindings.set(alias ?? module.split(".")[0], alias ? module : module.split(".")[0]);
          site(node, module, "import");
        }
      } else if (node.type === "import_from_statement") {
        const moduleNode = node.childForFieldName("module_name");
        if (!moduleNode || moduleNode.type === "relative_import" || !isSdk(moduleNode.text, modules))
          continue;
        for (const child of node.childrenForFieldName("name").filter((c): c is Node => c !== null)) {
          if (child.type === "aliased_import") {
            const name = child.childForFieldName("name")?.text ?? "";
            bindings.set(child.childForFieldName("alias")?.text ?? name, `${moduleNode.text}.${name}`);
          } else {
            bindings.set(child.text, `${moduleNode.text}.${child.text}`);
          }
        }
        site(node, moduleNode.text, "import");
      } else if (
        node.type === "call" &&
        DYNAMIC_IMPORTERS.has(dotted(node.childForFieldName("function")) ?? "")
      ) {
        const arg = stringLiteral(named(node.childForFieldName("arguments") as Node)[0]);
        if (arg && isSdk(arg, modules))
          unresolved.push(`dynamic import of ${arg} in ${rel}:${node.startPosition.row + 1}`);
      }
    }

    // Aliases of SDK names: FACTORY = ArmorIQClient
    for (const node of nodes) {
      if (node.type !== "assignment") continue;
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const name = dotted(right);
      if (left?.type === "identifier" && name && bindings.has(name.split(".")[0]))
        bindings.set(left.text, qualify(name));
    }

    // Objects created from SDK names: client = ArmorIQClient(...), self.c = ..., with ArmorIQClient() as c
    const instances = new Set<string>();
    const fromSdkCall = (value: Node | null): boolean => {
      if (!value) return false;
      const call = unwrap(value);
      const callee = call.type === "call" ? dotted(call.childForFieldName("function")) : null;
      return Boolean(callee && bindings.has(callee.split(".")[0]));
    };
    for (const node of nodes) {
      if (node.type === "assignment" && fromSdkCall(node.childForFieldName("right"))) {
        const target = dotted(node.childForFieldName("left"));
        if (target) instances.add(target);
      } else if (node.type === "as_pattern" && fromSdkCall(named(node)[0] ?? null)) {
        const target = node.childForFieldName("alias");
        const name = target ? dotted(named(target)[0] ?? target) : null;
        if (name) instances.add(name);
      }
    }
    const fromSdk = (callee: string): boolean =>
      bindings.has(callee.split(".")[0]) ||
      [...instances].some((i) => callee === i || callee.startsWith(`${i}.`));

    for (const node of nodes) {
      if (node.type === "class_definition") {
        // class Guard(ArmorIQClient): ...
        const bases = node.childForFieldName("superclasses");
        for (const base of bases ? named(bases) : []) {
          const name = dotted(base);
          if (name && bindings.has(name.split(".")[0]))
            site(node, qualify(name).split(".").at(-1) ?? name, "client_init");
        }
        continue;
      }
      if (node.type !== "call") continue;
      const fn = node.childForFieldName("function");
      const callee = dotted(fn);
      if (callee === null) {
        // Chained: ArmorIQClient().invoke(), (await ArmorIQClient.create()).invoke()
        if (fn?.type !== "attribute") continue;
        const inner = unwrap(fn.childForFieldName("object") as Node);
        const innerCallee = inner.type === "call" ? dotted(inner.childForFieldName("function")) : null;
        const method = fn.childForFieldName("attribute")?.text;
        if (innerCallee && method && fromSdk(innerCallee)) site(node, method, "call");
        continue;
      }
      if (bindings.has(callee.split(".")[0])) {
        const symbol = qualify(callee).split(".").at(-1) ?? callee;
        site(node, symbol, /^[A-Z]/.test(symbol) ? "client_init" : "call");
      } else if ([...instances].some((i) => callee.startsWith(`${i}.`))) {
        site(node, callee.split(".").at(-1) ?? callee, "call");
      }
    }

    if (tree.rootNode.hasError && modules.some((m) => source.includes(m))) {
      unresolved.push(`unparseable Python file mentions the ArmorIQ SDK: ${rel}`);
    }
    sites.sort((a, b) => a.line - b.line);
    return { sites, unresolved };
  } finally {
    tree.delete();
  }
}

/** Scan the code cells of a Jupyter notebook; IPython magics (%pip, !cmd) are dropped. */
export function scanNotebook(
  rel: string,
  text: string,
  modules: string[],
  inTest: boolean,
  redactor: SecretRedactor,
): ScanResult {
  const code = notebookSource(text, true)
    .split("\n")
    .filter((line) => !/^\s*[%!]/.test(line))
    .join("\n");
  return scanPython(rel, code, modules, inTest, redactor);
}
