/** Loads tree-sitter grammars (WebAssembly) once; parsers are created per file. */
import { createRequire } from "node:module";
import { Language, type Node, Parser, type Tree } from "web-tree-sitter";

export type Grammar = "python" | "javascript" | "typescript" | "tsx";
export type { Node, Tree };

const WASM: Record<Grammar, string> = {
  python: "tree-sitter-python/tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
};

let languages: Record<Grammar, Language> | null = null;
let loading: Promise<void> | null = null;

export function initTreeSitter(): Promise<void> {
  loading ??= (async () => {
    const require = createRequire(import.meta.url);
    await Parser.init();
    const entries = await Promise.all(
      (Object.keys(WASM) as Grammar[]).map(
        async (g) => [g, await Language.load(require.resolve(WASM[g]))] as const,
      ),
    );
    languages = Object.fromEntries(entries) as Record<Grammar, Language>;
  })();
  return loading;
}

/** Parse source text. Call `tree.delete()` when done (WASM memory is not garbage collected). */
export function parse(grammar: Grammar, source: string): Tree {
  if (!languages) throw new Error("tree-sitter is not initialized; await initTreeSitter() first");
  const parser = new Parser();
  try {
    parser.setLanguage(languages[grammar]);
    const tree = parser.parse(source);
    if (!tree) throw new Error(`tree-sitter failed to parse ${grammar} source`);
    return tree;
  } finally {
    parser.delete();
  }
}

/** All nodes in document order (pre-order, iterative so deep files cannot overflow the stack). */
export function allNodes(root: Node): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop() as Node;
    out.push(node);
    const children = node.children.filter((c): c is Node => c !== null);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

export const named = (node: Node): Node[] => node.namedChildren.filter((c): c is Node => c !== null);
