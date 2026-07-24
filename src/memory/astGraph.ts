import path from "node:path";
import type { EntityGraph } from "./entityGraph.js";

export interface CodeDependency {
  moduleName: string;
  imports: string[];
  exports: string[];
}

/**
 * Lightweight regex-based AST parser for TypeScript/JavaScript dependency extraction.
 * Extracts imports and exported symbols from code content without requiring heavy external compilers.
 */
export function extractCodeDependencies(content: string, filePath?: string): CodeDependency {
  const moduleName = filePath ? path.basename(filePath) : "anonymous_module";
  const imports: string[] = [];
  const exports: string[] = [];

  // Match import statements: import { a, b } from "module" or import foo from "module"
  const importRegex = /import\s+(?:(?:\{([^}]+)\})|(?:[\w$]+))\s+from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    if (match[1]) {
      const symbols = match[1].split(",").map((s) => s.trim().split(" as ")[0].trim()).filter(Boolean);
      imports.push(...symbols);
    } else if (match[2]) {
      imports.push(match[2]);
    }
  }

  // Match export statements: export class/function/interface/type/const Foo
  const exportRegex = /export\s+(?:default\s+)?(?:class|function|interface|type|const|let|var)\s+([\w$]+)/g;
  while ((match = exportRegex.exec(content)) !== null) {
    if (match[1]) exports.push(match[1]);
  }

  return {
    moduleName,
    imports: [...new Set(imports)],
    exports: [...new Set(exports)],
  };
}

/**
 * Index AST dependencies into EntityGraph automatically.
 */
export async function indexAstDependencies(
  graph: EntityGraph,
  memoryId: string,
  content: string,
  filePath?: string
): Promise<void> {
  const deps = extractCodeDependencies(content, filePath);
  const tags = [...deps.imports, ...deps.exports, deps.moduleName];
  await graph.indexMemory(memoryId, content, tags);
}
