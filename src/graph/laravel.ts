/**
 * Laravel-specific extractors for Trail.
 *
 * Provides specialized extraction for:
 * 1. Configuration files (config/*.php): Extracts top-level return array keys and nested keys.
 * 2. Route files (routes/*.php): Extracts Route definitions, methods, URIs, names, and controllers.
 * 3. Blade template files (resources/views/** /*.blade.php): Extracts layout inheritance (@extends),
 *    partial inclusions (@include), component usages (<x-*>), Livewire components, and Alpine bindings.
 */
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import type { SyntaxNode } from "./depth-parser.js";
import type { NodeV1 } from "./types.js";
import type { ExtractResult, RawEdge, WalkCtx } from "./extract.js";
import { mintId } from "./extract.js";

export function isBladeFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  return norm.endsWith(".blade.php");
}

export function isLaravelConfigFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return (norm.startsWith("config/") || norm.includes("/config/")) && norm.endsWith(".php");
}

export function isLaravelRouteFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return (norm.startsWith("routes/") || norm.includes("/routes/")) && norm.endsWith(".php");
}

export function isLaravelMigrationFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return (norm.includes("/migrations/") || norm.startsWith("database/migrations/")) && norm.endsWith(".php");
}

export function isLaravelBootstrapFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return (
    norm === "bootstrap/providers.php" ||
    norm.endsWith("/bootstrap/providers.php") ||
    norm === "bootstrap/app.php" ||
    norm.endsWith("/bootstrap/app.php")
  );
}

export function isLaravelConsoleFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return (
    norm.endsWith("routes/console.php") ||
    norm.includes("/Console/Commands/") ||
    (norm.includes("/Commands/") && norm.endsWith(".php"))
  );
}

export function isLaravelModelFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return (
    (norm.includes("/Models/") || norm.includes("/app/Models/")) &&
    norm.endsWith(".php")
  );
}

export function isLaravelSeederFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return (norm.includes("/seeders/") || norm.startsWith("database/seeders/")) && norm.endsWith(".php");
}

function searchBody(text: string, max = 500): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

export function extractStringValue(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "argument") {
    return extractStringValue(node.namedChildren[0]);
  }
  if (node.type === "string" || node.type === "encapsed_string") {
    const content = node.namedChildren.find((c) => c.type === "string_content");
    if (content) return content.text;
    const txt = node.text.trim();
    if ((txt.startsWith("'") && txt.endsWith("'")) || (txt.startsWith('"') && txt.endsWith('"'))) {
      return txt.slice(1, -1);
    }
    return txt;
  }
  if (node.type === "name" || node.type === "identifier") {
    return node.text;
  }
  return null;
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function lineAt(offsets: number[], index: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return low;
}

function findClassConstants(node: SyntaxNode, out: string[] = []): string[] {
  if (node.type === "class_constant_access_expression") {
    const clsNode = node.namedChildren[0];
    if (clsNode) {
      const clsName = clsNode.text.replace(/^.*\\/, "");
      out.push(clsName);
    }
  }
  for (const child of node.namedChildren) {
    findClassConstants(child, out);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Config Extractor (config/*.php)                                             */
/* -------------------------------------------------------------------------- */

export function extractLaravelConfig(
  rel: string,
  source: string,
  root: SyntaxNode,
  ctx: WalkCtx,
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  minted: Set<string>,
): void {
  const findReturnArray = (node: SyntaxNode): SyntaxNode | null => {
    if (node.type === "return_statement") {
      const arr = node.namedChildren.find((c) => c.type === "array_creation_expression");
      if (arr) return arr;
    }
    for (const child of node.namedChildren) {
      if (child.type === "function_definition" || child.type === "class_declaration") continue;
      const found = findReturnArray(child);
      if (found) return found;
    }
    return null;
  };

  const returnArr = findReturnArray(root);
  if (!returnArr) return;

  const configStem = basename(rel, ".php");

  const processArray = (arrNode: SyntaxNode, prefix = "", depth = 0) => {
    if (depth > 3) return;
    for (const elem of arrNode.namedChildren) {
      if (elem.type !== "array_element_initializer") continue;

      if (elem.namedChildren.length >= 2) {
        const keyNode = elem.namedChildren[0];
        const valNode = elem.namedChildren[1];
        const keyName = extractStringValue(keyNode);
        if (!keyName) continue;

        const keyPath = prefix ? `${prefix}.${keyName}` : keyName;
        const startLine = keyNode.startPosition.row + 1;
        const endLine = valNode.endPosition.row + 1;
        const span = `L${startLine}-L${endLine}`;
        const id = mintId(`${rel}#${keyPath}`, minted);

        const valText = valNode.text.length > 50 ? `${valNode.text.slice(0, 47)}...` : valNode.text;
        const signature = `config('${configStem}.${keyPath}') => ${valText.replace(/\s+/g, " ")}`;

        nodes.push({
          id,
          name: keyPath,
          kind: "constant",
          path: rel,
          span,
          signature,
          exported: true,
          origin: "ast",
          body_hash: contentHash(elem.text),
          body_text: searchBody(elem.text),
          summary_state: "pending",
          summary: null,
          crux: null,
        });

        rawEdges.push({
          source: ctx.parentId,
          relation: "contains",
          targetId: id,
          file: rel,
        });

        const classes = findClassConstants(valNode);
        for (const cls of classes) {
          rawEdges.push({
            source: id,
            relation: "imports",
            name: cls,
            file: rel,
          });
        }

        if (valNode.type === "array_creation_expression") {
          processArray(valNode, keyPath, depth + 1);
        }
      } else if (elem.namedChildren.length === 1) {
        const valNode = elem.namedChildren[0];
        const classes = findClassConstants(valNode);
        for (const cls of classes) {
          rawEdges.push({
            source: ctx.parentId,
            relation: "imports",
            name: cls,
            file: rel,
          });
        }
      }
    }
  };

  processArray(returnArr);
}

/* -------------------------------------------------------------------------- */
/* Route Extractor (routes/*.php)                                             */
/* -------------------------------------------------------------------------- */

const ROUTE_VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "any",
  "match",
  "resource",
  "apiResource",
  "view",
  "redirect",
]);

interface CallStep {
  name: string;
  args: SyntaxNode[];
  node: SyntaxNode;
}

function unwindCallChain(expr: SyntaxNode): { baseScope: string | null; steps: CallStep[] } {
  const steps: CallStep[] = [];
  let curr: SyntaxNode | null = expr;
  let baseScope: string | null = null;

  while (curr) {
    if (curr.type === "member_call_expression") {
      const nameNode = curr.namedChildren.find((c) => c.type === "name" || c.type === "identifier");
      const argsNode = curr.namedChildren.find((c) => c.type === "arguments");
      const args = argsNode ? argsNode.namedChildren.filter((c) => c.type === "argument") : [];
      if (nameNode) {
        steps.unshift({ name: nameNode.text, args, node: curr });
      }
      curr = curr.namedChildren[0] ?? null;
    } else if (curr.type === "scoped_call_expression") {
      const scopeNode = curr.namedChildren[0];
      const nameNode = curr.namedChildren[1];
      const argsNode = curr.namedChildren.find((c) => c.type === "arguments");
      const args = argsNode ? argsNode.namedChildren.filter((c) => c.type === "argument") : [];
      if (scopeNode) baseScope = scopeNode.text;
      if (nameNode) {
        steps.unshift({ name: nameNode.text, args, node: curr });
      }
      break;
    } else {
      break;
    }
  }

  return { baseScope, steps };
}

export function extractLaravelRoutes(
  rel: string,
  source: string,
  root: SyntaxNode,
  ctx: WalkCtx,
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  minted: Set<string>,
): void {
  const visitStatements = (
    statements: SyntaxNode[],
    parentPrefix = "",
    parentController = "",
  ) => {
    for (const stmt of statements) {
      if (stmt.type !== "expression_statement") continue;
      const expr = stmt.namedChildren[0];
      if (!expr) continue;

      const { baseScope, steps } = unwindCallChain(expr);
      if (steps.length === 0) continue;

      const isRouteCall =
        baseScope === "Route" ||
        baseScope === "$router" ||
        steps.some((s) => ROUTE_VERBS.has(s.name) || s.name === "group" || s.name === "prefix");

      if (!isRouteCall) continue;

      let routeVerb: string | null = null;
      let routeUri: string | null = null;
      let routeName: string | null = null;
      let routePrefix: string | null = null;
      let routeController: string | null = parentController;
      let routeActionMethod: string | null = null;
      let groupClosure: SyntaxNode | null = null;

      for (const step of steps) {
        if (ROUTE_VERBS.has(step.name)) {
          routeVerb = step.name.toUpperCase();
          if (step.args.length > 0) {
            const firstArg = step.args[0].namedChildren[0] ?? step.args[0];
            routeUri = extractStringValue(firstArg) ?? "/";
          }
          if (step.args.length > 1) {
            const secondArg = step.args[1].namedChildren[0] ?? step.args[1];
            if (secondArg.type === "array_creation_expression") {
              const classes = findClassConstants(secondArg);
              if (classes.length > 0) routeController = classes[0];
              const methodInit = secondArg.namedChildren[1];
              if (methodInit) {
                const methodVal = methodInit.namedChildren[1] ?? methodInit.namedChildren[0];
                routeActionMethod = extractStringValue(methodVal);
              }
            } else if (secondArg.type === "string" || secondArg.type === "encapsed_string") {
              const str = extractStringValue(secondArg);
              if (str && str.includes("@")) {
                const [c, m] = str.split("@");
                routeController = c;
                routeActionMethod = m;
              } else if (str) {
                routeActionMethod = str;
              }
            } else {
              const classes = findClassConstants(secondArg);
              if (classes.length > 0) routeController = classes[0];
            }
          }
        } else if (step.name === "name" && step.args.length > 0) {
          const arg = step.args[0].namedChildren[0] ?? step.args[0];
          routeName = extractStringValue(arg);
        } else if (step.name === "prefix" && step.args.length > 0) {
          const arg = step.args[0].namedChildren[0] ?? step.args[0];
          routePrefix = extractStringValue(arg);
        } else if (step.name === "controller" && step.args.length > 0) {
          const classes = findClassConstants(step.args[0]);
          if (classes.length > 0) routeController = classes[0];
        } else if (step.name === "group" && step.args.length > 0) {
          for (const arg of step.args) {
            const inner = arg.namedChildren[0] ?? arg;
            if (inner.type === "anonymous_function" || inner.type === "arrow_function") {
              groupClosure = inner;
            } else if (inner.type === "array_creation_expression") {
              for (const elem of inner.namedChildren) {
                if (elem.type === "array_element_initializer" && elem.namedChildren.length >= 2) {
                  const k = extractStringValue(elem.namedChildren[0]);
                  if (k === "prefix") {
                    routePrefix = extractStringValue(elem.namedChildren[1]);
                  }
                }
              }
            }
          }
        }
      }

      if (routeVerb && routeUri !== null) {
        let fullUri = routeUri;
        if (parentPrefix) {
          const cleanP = parentPrefix.replace(/\/+$/, "");
          const cleanU = routeUri.replace(/^\/+/, "");
          fullUri = cleanU ? `${cleanP}/${cleanU}` : cleanP;
        }
        if (!fullUri.startsWith("/")) fullUri = `/${fullUri}`;

        const displayName = routeName ? `${routeVerb} ${fullUri} (${routeName})` : `${routeVerb} ${fullUri}`;
        const startLine = stmt.startPosition.row + 1;
        const endLine = stmt.endPosition.row + 1;
        const span = `L${startLine}-L${endLine}`;
        const id = mintId(`${rel}#${displayName}`, minted);

        const sigLine = stmt.text.split("\n")[0].trim();
        const signature = sigLine.length > 80 ? `${sigLine.slice(0, 77)}...` : sigLine;

        nodes.push({
          id,
          name: displayName,
          kind: "endpoint",
          path: rel,
          span,
          signature,
          exported: true,
          origin: "ast",
          body_hash: contentHash(stmt.text),
          body_text: searchBody(stmt.text),
          summary_state: "pending",
          summary: null,
          crux: null,
        });

        rawEdges.push({
          source: ctx.parentId,
          relation: "contains",
          targetId: id,
          file: rel,
        });

        if (routeController) {
          rawEdges.push({
            source: id,
            relation: "calls",
            name: routeController,
            file: rel,
            kinds: ["class"],
          });
        }
        if (routeActionMethod) {
          rawEdges.push({
            source: id,
            relation: "calls",
            name: routeActionMethod,
            file: rel,
            kinds: ["method", "function"],
          });
        }
      } else if (groupClosure) {
        const effectivePrefix = routePrefix
          ? parentPrefix
            ? `${parentPrefix}/${routePrefix}`
            : routePrefix
          : parentPrefix;

        const groupLabel = effectivePrefix ? `Route::group (${effectivePrefix})` : `Route::group`;
        const startLine = stmt.startPosition.row + 1;
        const endLine = stmt.endPosition.row + 1;
        const span = `L${startLine}-L${endLine}`;
        const id = mintId(`${rel}#${groupLabel}`, minted);

        nodes.push({
          id,
          name: groupLabel,
          kind: "endpoint",
          path: rel,
          span,
          signature: groupLabel,
          exported: true,
          origin: "ast",
          body_hash: contentHash(stmt.text),
          body_text: searchBody(stmt.text),
          summary_state: "pending",
          summary: null,
          crux: null,
        });

        rawEdges.push({
          source: ctx.parentId,
          relation: "contains",
          targetId: id,
          file: rel,
        });

        const body = groupClosure.childForFieldName("body") ?? groupClosure.namedChildren.find((c) => c.type === "compound_statement");
        if (body) {
          visitStatements(body.namedChildren, effectivePrefix, routeController ?? parentController);
        }
      }
    }
  };

  visitStatements(root.namedChildren);
}

/* -------------------------------------------------------------------------- */
/* Blade Template Extractor (resources/views/** /*.blade.php)                 */
/* -------------------------------------------------------------------------- */

export function extractBladeFile(rel: string, source: string): ExtractResult {
  const lineOffsets = buildLineOffsets(source);
  const totalLines = lineOffsets.length;
  const minted = new Set<string>([rel]);

  const nodes: NodeV1[] = [
    {
      id: rel,
      name: basename(rel),
      kind: "file",
      path: rel,
      span: `L1-L${totalLines}`,
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(source),
      chars: source.length,
      summary_state: "pending",
      summary: null,
      crux: null,
    },
  ];
  const rawEdges: RawEdge[] = [];

  const addSymbol = (
    name: string,
    matchIndex: number,
    matchedText: string,
    edge?: { relation: "extends" | "imports" | "calls"; targetName: string },
  ) => {
    const line = lineAt(lineOffsets, matchIndex);
    const span = `L${line}-L${line}`;
    const id = mintId(`${rel}#${name}`, minted);

    const firstLine = matchedText.split("\n")[0].trim();
    const signature = firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;

    nodes.push({
      id,
      name,
      kind: "template",
      path: rel,
      span,
      signature,
      exported: true,
      origin: "ast",
      body_hash: contentHash(matchedText),
      body_text: searchBody(matchedText),
      summary_state: "pending",
      summary: null,
      crux: null,
    });

    rawEdges.push({
      source: rel,
      relation: "contains",
      targetId: id,
      file: rel,
    });

    if (edge) {
      rawEdges.push({
        source: id,
        relation: edge.relation,
        name: edge.targetName,
        file: rel,
      });
    }
  };

  // 1. Layout inheritance (@extends, @section, @yield)
  const EXTENDS_REGEX = /@extends\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = EXTENDS_REGEX.exec(source)) !== null) {
    const layout = match[1];
    addSymbol(`@extends('${layout}')`, match.index, match[0], {
      relation: "extends",
      targetName: layout,
    });
  }

  const SECTION_REGEX = /@section\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = SECTION_REGEX.exec(source)) !== null) {
    const sec = match[1];
    addSymbol(`@section('${sec}')`, match.index, match[0]);
  }

  const YIELD_REGEX = /@yield\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = YIELD_REGEX.exec(source)) !== null) {
    const yld = match[1];
    addSymbol(`@yield('${yld}')`, match.index, match[0]);
  }

  // 2. Partial inclusions (@include, @includeIf, @includeWhen, @includeUnless, @includeFirst)
  const INCLUDE_REGEX = /@(?:include|includeIf|includeWhen|includeUnless|includeFirst)\s*\(\s*(?:\[\s*)?['"]([^'"]+)['"]/g;
  while ((match = INCLUDE_REGEX.exec(source)) !== null) {
    const inc = match[1];
    addSymbol(`@include('${inc}')`, match.index, match[0], {
      relation: "imports",
      targetName: inc,
    });
  }

  // 3. Blade component usages (<x-component-name />)
  const COMPONENT_REGEX = /<\s*x-([a-zA-Z0-9_.:-]+)([^>]*?)(?:\/?>)/g;
  while ((match = COMPONENT_REGEX.exec(source)) !== null) {
    const comp = match[1];
    if (comp.startsWith("slot")) {
      addSymbol(`<x-${comp}>`, match.index, match[0]);
    } else {
      addSymbol(`<x-${comp}>`, match.index, match[0], {
        relation: "calls",
        targetName: comp,
      });
    }
  }

  // 4. Livewire components (<livewire:component-name />, @livewire('name'))
  const LIVEWIRE_TAG_REGEX = /<\s*livewire:([a-zA-Z0-9_.-]+)([^>]*?)(?:\/?>)/g;
  while ((match = LIVEWIRE_TAG_REGEX.exec(source)) !== null) {
    const lw = match[1];
    addSymbol(`<livewire:${lw}>`, match.index, match[0], {
      relation: "calls",
      targetName: lw,
    });
  }

  const LIVEWIRE_DIRECTIVE_REGEX = /@livewire\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = LIVEWIRE_DIRECTIVE_REGEX.exec(source)) !== null) {
    const lw = match[1];
    addSymbol(`@livewire('${lw}')`, match.index, match[0], {
      relation: "calls",
      targetName: lw,
    });
  }

  // 5. Alpine.js bindings (x-data)
  const ALPINE_DATA_REGEX = /\bx-data(?:\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+)))?/g;
  while ((match = ALPINE_DATA_REGEX.exec(source)) !== null) {
    const rawData = match[1] ?? match[2] ?? match[3] ?? "";
    const cleanData = rawData.replace(/\s+/g, " ").trim();
    const dataDesc = cleanData.length > 25 ? `${cleanData.slice(0, 22)}...` : cleanData;
    const name = dataDesc ? `alpine:x-data (${dataDesc})` : `alpine:x-data`;
    addSymbol(name, match.index, match[0]);
  }

  // 6. Component Definition (for files inside components/)
  const normRel = rel.replace(/\\/g, "/");
  const compMatch = /(?:^|\/)components\/(.+)\.blade\.php$/i.exec(normRel);
  if (compMatch) {
    const rawComp = compMatch[1].replace(/\//g, ".");
    const modMatch = /^Modules\/([^/]+)\//i.exec(normRel);
    const compTag = modMatch
      ? `<x-${modMatch[1].toLowerCase()}::${rawComp}>`
      : `<x-${rawComp}>`;
    addSymbol(`component: ${compTag}`, 0, compTag);
  }

  // 7. Component Slots ($slot)
  const SLOT_REGEX = /\{\{\s*\$slot\s*\}\}|\$slot\b/g;
  while ((match = SLOT_REGEX.exec(source)) !== null) {
    addSymbol("$slot", match.index, match[0]);
  }

  // 8. Component Props (@props)
  const PROPS_REGEX = /@props\s*\(\s*(\[[^\]]*\]|['"][^'"]*['"])\s*\)/g;
  while ((match = PROPS_REGEX.exec(source)) !== null) {
    const pStr = match[1].replace(/\s+/g, " ");
    const pDesc = pStr.length > 30 ? `${pStr.slice(0, 27)}...` : pStr;
    addSymbol(`@props(${pDesc})`, match.index, match[0]);
  }

  // 9. Stacks & Push (@stack, @push)
  const STACK_REGEX = /@stack\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = STACK_REGEX.exec(source)) !== null) {
    addSymbol(`@stack('${match[1]}')`, match.index, match[0]);
  }

  const PUSH_REGEX = /@push\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = PUSH_REGEX.exec(source)) !== null) {
    addSymbol(`@push('${match[1]}')`, match.index, match[0]);
  }

  // 10. Route calls (route('...'), Route::has('...'))
  const ROUTE_CALL_REGEX = /(?:route|Route::has)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = ROUTE_CALL_REGEX.exec(source)) !== null) {
    const rName = match[1];
    addSymbol(`route('${rName}')`, match.index, match[0], {
      relation: "calls",
      targetName: rName,
    });
  }

  // 11. @php blocks
  const PHP_BLOCK_REGEX = /@php\b/g;
  while ((match = PHP_BLOCK_REGEX.exec(source)) !== null) {
    addSymbol("@php block", match.index, match[0]);
  }

  // 12. @vite assets
  const VITE_REGEX = /@vite\s*\(\s*(\[[^\]]*\]|['"][^'"]*['"])\s*\)/g;
  while ((match = VITE_REGEX.exec(source)) !== null) {
    const rawVal = match[1];
    addSymbol(`@vite(${rawVal.length > 30 ? rawVal.slice(0, 27) + "..." : rawVal})`, match.index, match[0]);
    const assetMatches = rawVal.matchAll(/['"]([^'"]+)['"]/g);
    for (const am of assetMatches) {
      rawEdges.push({
        source: rel,
        relation: "imports",
        name: am[1],
        file: rel,
      });
    }
  }

  nodes[0].body_text = searchBody(source, 2000);
  return { nodes, rawEdges };
}

/* -------------------------------------------------------------------------- */
/* Migration & Schema Extractor (database/migrations/*.php)                  */
/* -------------------------------------------------------------------------- */

export function extractLaravelMigrations(
  rel: string,
  source: string,
  root: SyntaxNode,
  ctx: WalkCtx,
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  minted: Set<string>,
): void {
  function findSchemaCalls(node: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
    if (node.type === "scoped_call_expression") {
      const scopeNode = node.namedChildren[0];
      const methodNode = node.namedChildren[1];
      if (
        scopeNode &&
        methodNode &&
        scopeNode.text === "Schema" &&
        (methodNode.text === "create" || methodNode.text === "table")
      ) {
        out.push(node);
      }
    }
    for (const child of node.namedChildren) {
      findSchemaCalls(child, out);
    }
    return out;
  }

  const calls = findSchemaCalls(root);
  for (const callNode of calls) {
    const methodNode = callNode.namedChildren[1];
    const methodName = methodNode?.text ?? "create";
    const argsNode = callNode.namedChildren.find((c) => c.type === "arguments");
    if (!argsNode) continue;

    const tableArg = argsNode.namedChildren.find((c) => c.type === "argument");
    const tableName = extractStringValue(tableArg);
    if (!tableName) continue;

    const startLine = callNode.startPosition.row + 1;
    const endLine = callNode.endPosition.row + 1;
    const span = `L${startLine}-L${endLine}`;
    const id = mintId(`${rel}#table:${tableName}`, minted);

    const columns: string[] = [];
    const foreignKeys: string[] = [];

    // Find the closure argument
    const closureArg = argsNode.namedChildren.find(
      (c) =>
        c.type === "argument" &&
        (c.namedChildren[0]?.type === "anonymous_function" ||
          c.namedChildren[0]?.type === "arrow_function"),
    );
    const closure = closureArg?.namedChildren[0];
    if (closure) {
      const body = closure.namedChildren.find((c) => c.type === "compound_statement");
      if (body) {
        for (const stmt of body.namedChildren) {
          if (stmt.type !== "expression_statement") continue;
          let curr: SyntaxNode | null = stmt.namedChildren[0] ?? null;
          const steps: Array<{ name: string; args: string[] }> = [];

          while (curr && curr.type === "member_call_expression") {
            const mName = curr.namedChildren.find((c) => c.type === "name" || c.type === "identifier")?.text;
            const mArgs =
              curr.namedChildren
                .find((c) => c.type === "arguments")
                ?.namedChildren.filter((c) => c.type === "argument")
                .map((a) => {
                  const s = extractStringValue(a);
                  return s !== null ? s : a.text;
                }) ?? [];
            if (mName) steps.unshift({ name: mName, args: mArgs });
            curr = curr.namedChildren[0] ?? null;
          }

          if (steps.length === 0) continue;
          const baseStep = steps[0];
          const colType = baseStep.name;
          const colName =
            baseStep.args[0] ??
            (colType === "id" ? "id" : colType === "timestamps" ? "timestamps" : "");

          if (colType === "foreignId" || colType === "foreign") {
            const constrainedStep = steps.find((s) => s.name === "constrained");
            const onStep = steps.find((s) => s.name === "on");
            let targetTable = constrainedStep?.args[0] || onStep?.args[0];
            if (!targetTable && constrainedStep && colName.endsWith("_id")) {
              const base = colName.slice(0, -3);
              targetTable = `${base}s`;
            }
            if (targetTable) {
              foreignKeys.push(targetTable);
              columns.push(`${colName} (fk → ${targetTable})`);
            } else {
              columns.push(`${colName} (foreignId)`);
            }
          } else if (colName) {
            columns.push(colType === colName ? colName : `${colType}: ${colName}`);
          }
        }
      }
    }

    const colsSummary =
      columns.slice(0, 6).join(", ") + (columns.length > 6 ? ", ..." : "");
    const signature = `Schema::${methodName}('${tableName}') [${colsSummary}]`;

    nodes.push({
      id,
      name: `table: ${tableName}`,
      kind: "type",
      path: rel,
      span,
      signature,
      exported: true,
      origin: "ast",
      body_hash: contentHash(callNode.text),
      body_text: `Database Table '${tableName}' (${methodName})\nColumns: ${columns.join(", ")}`,
      summary_state: "pending",
      summary: null,
      crux: null,
    });

    rawEdges.push({
      source: rel,
      relation: "contains",
      targetId: id,
      file: rel,
    });

    for (const fk of foreignKeys) {
      rawEdges.push({
        source: id,
        relation: "calls",
        name: `table: ${fk}`,
        kinds: ["type"],
        file: rel,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap & ServiceProvider Extractor                                      */
/* -------------------------------------------------------------------------- */

export function extractLaravelBootstrap(
  rel: string,
  source: string,
  root: SyntaxNode,
  ctx: WalkCtx,
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  minted: Set<string>,
): void {
  const norm = rel.replace(/\\/g, "/");

  // A. bootstrap/providers.php
  if (norm.endsWith("providers.php")) {
    const findReturnArray = (node: SyntaxNode): SyntaxNode | null => {
      if (node.type === "return_statement") {
        const arr = node.namedChildren.find((c) => c.type === "array_creation_expression");
        if (arr) return arr;
      }
      for (const child of node.namedChildren) {
        const found = findReturnArray(child);
        if (found) return found;
      }
      return null;
    };

    const returnArr = findReturnArray(root);
    if (returnArr) {
      for (const elem of returnArr.namedChildren) {
        if (elem.type !== "array_element_initializer") continue;
        const constAccess = elem.namedChildren.find(
          (c) => c.type === "class_constant_access_expression",
        );
        if (constAccess) {
          const clsNode = constAccess.namedChildren[0];
          if (!clsNode) continue;
          const fullCls = clsNode.text;
          const shortCls = fullCls.split("\\").pop() || fullCls;
          const startLine = elem.startPosition.row + 1;
          const endLine = elem.endPosition.row + 1;
          const span = `L${startLine}-L${endLine}`;
          const id = mintId(`${rel}#provider:${shortCls}`, minted);

          nodes.push({
            id,
            name: `service-provider: ${shortCls}`,
            kind: "class",
            path: rel,
            span,
            signature: `${shortCls}::class`,
            exported: true,
            origin: "ast",
            body_hash: contentHash(elem.text),
            body_text: `Registered Service Provider: ${fullCls}`,
            summary_state: "pending",
            summary: null,
            crux: null,
          });

          rawEdges.push({
            source: rel,
            relation: "contains",
            targetId: id,
            file: rel,
          });

          rawEdges.push({
            source: id,
            relation: "imports",
            name: shortCls,
            kinds: ["class"],
            file: rel,
          });
        }
      }
    }
  }

  // B. bootstrap/app.php
  if (norm.endsWith("app.php")) {
    function findReturn(node: SyntaxNode): SyntaxNode | null {
      if (node.type === "return_statement") return node;
      for (const c of node.namedChildren) {
        const found = findReturn(c);
        if (found) return found;
      }
      return null;
    }

    const ret = findReturn(root);
    if (ret) {
      let curr: SyntaxNode | null = ret.namedChildren[0] ?? null;
      const steps: Array<{ name: string; args: string[]; node: SyntaxNode }> = [];

      while (curr) {
        if (curr.type === "member_call_expression") {
          const name = curr.namedChildren.find((c) => c.type === "name" || c.type === "identifier")?.text;
          const args =
            curr.namedChildren
              .find((c) => c.type === "arguments")
              ?.namedChildren.filter((c) => c.type === "argument")
              .map((a) => a.text) ?? [];
          if (name) steps.unshift({ name, args, node: curr });
          curr = curr.namedChildren[0] ?? null;
        } else if (curr.type === "scoped_call_expression") {
          const scope = curr.namedChildren[0]?.text;
          const name = curr.namedChildren[1]?.text;
          if (scope && name) {
            steps.unshift({ name: `${scope}::${name}`, args: [], node: curr });
          }
          break;
        } else {
          break;
        }
      }

      for (const step of steps) {
        if (
          step.name === "withRouting" ||
          step.name === "withMiddleware" ||
          step.name === "withExceptions"
        ) {
          const startLine = step.node.startPosition.row + 1;
          const endLine = step.node.endPosition.row + 1;
          const span = `L${startLine}-L${endLine}`;
          const id = mintId(`${rel}#bootstrap:${step.name}`, minted);

          let sig = `Application::configure()->${step.name}(...)`;
          let bodyText = `Bootstrap Configuration: ${step.name}`;

          if (step.name === "withRouting") {
            const routeNames = step.args.map((a) => a.split(":")[0]?.trim()).filter(Boolean);
            sig = `withRouting(${routeNames.join(", ")})`;
            bodyText = `Application routing files configured:\n${step.args.join("\n")}`;
          }

          nodes.push({
            id,
            name: `bootstrap: ${step.name}`,
            kind: "function",
            path: rel,
            span,
            signature: sig,
            exported: true,
            origin: "ast",
            body_hash: contentHash(step.node.text),
            body_text: bodyText,
            summary_state: "pending",
            summary: null,
            crux: null,
          });

          rawEdges.push({
            source: rel,
            relation: "contains",
            targetId: id,
            file: rel,
          });
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Artisan Console Extractor (routes/console.php, Commands/*.php)             */
/* -------------------------------------------------------------------------- */

export function extractLaravelConsole(
  rel: string,
  source: string,
  root: SyntaxNode,
  ctx: WalkCtx,
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  minted: Set<string>,
): void {
  const norm = rel.replace(/\\/g, "/");

  // 1. routes/console.php (Artisan::command)
  if (norm.endsWith("console.php")) {
    function findExprStmts(node: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
      if (node.type === "expression_statement") out.push(node);
      for (const c of node.namedChildren) findExprStmts(c, out);
      return out;
    }

    const exprs = findExprStmts(root);
    for (const expr of exprs) {
      let curr: SyntaxNode | null = expr.namedChildren[0] ?? null;
      const steps: Array<{ name: string; args: SyntaxNode[]; node: SyntaxNode }> = [];
      let baseScope: string | null = null;

      while (curr) {
        if (curr.type === "member_call_expression") {
          const name = curr.namedChildren.find((c) => c.type === "name" || c.type === "identifier")?.text;
          const args =
            curr.namedChildren
              .find((c) => c.type === "arguments")
              ?.namedChildren.filter((c) => c.type === "argument") ?? [];
          if (name) steps.unshift({ name, args, node: curr });
          curr = curr.namedChildren[0] ?? null;
        } else if (curr.type === "scoped_call_expression") {
          baseScope = curr.namedChildren[0]?.text ?? null;
          const name = curr.namedChildren[1]?.text;
          const args =
            curr.namedChildren
              .find((c) => c.type === "arguments")
              ?.namedChildren.filter((c) => c.type === "argument") ?? [];
          if (name) steps.unshift({ name, args, node: curr });
          break;
        } else {
          break;
        }
      }

      if (baseScope === "Artisan" && steps.length > 0 && steps[0].name === "command") {
        const cmdStep = steps[0];
        const cmdSignature = extractStringValue(cmdStep.args[0]);
        if (!cmdSignature) continue;

        const purposeStep = steps.find((s) => s.name === "purpose" || s.name === "describe");
        const purposeText = purposeStep ? extractStringValue(purposeStep.args[0]) : null;

        const startLine = expr.startPosition.row + 1;
        const endLine = expr.endPosition.row + 1;
        const span = `L${startLine}-L${endLine}`;
        const id = mintId(`${rel}#command:${cmdSignature}`, minted);

        const signature =
          `Artisan::command('${cmdSignature}')` + (purposeText ? ` — ${purposeText}` : "");

        nodes.push({
          id,
          name: `command: ${cmdSignature}`,
          kind: "endpoint",
          path: rel,
          span,
          signature,
          exported: true,
          origin: "ast",
          body_hash: contentHash(expr.text),
          body_text: searchBody(expr.text, 500),
          summary_state: "pending",
          summary: null,
          crux: null,
        });

        rawEdges.push({
          source: rel,
          relation: "contains",
          targetId: id,
          file: rel,
        });
      }
    }
  }

  // 2. Command classes (extending Command)
  function findClasses(node: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
    if (node.type === "class_declaration") out.push(node);
    for (const c of node.namedChildren) findClasses(c, out);
    return out;
  }

  const classes = findClasses(root);
  for (const cls of classes) {
    const baseClause = cls.namedChildren.find((c) => c.type === "base_clause");
    if (!baseClause || !baseClause.text.includes("Command")) continue;

    const clsNameNode = cls.namedChildren.find((c) => c.type === "name");
    const clsName = clsNameNode?.text ?? basename(rel, ".php");
    const declList = cls.namedChildren.find((c) => c.type === "declaration_list");
    if (!declList) continue;

    let signatureVal: string | null = null;
    let descriptionVal: string | null = null;
    let sigLine = cls.startPosition.row + 1;

    for (const decl of declList.namedChildren) {
      if (decl.type !== "property_declaration") continue;
      const propElem = decl.namedChildren.find((c) => c.type === "property_element");
      if (!propElem) continue;
      const varName = propElem.namedChildren.find((c) => c.type === "variable_name")?.text;
      const valNode = propElem.namedChildren.find(
        (c) => c.type === "string" || c.type === "encapsed_string",
      );
      if (varName === "$signature" || varName === "$name") {
        signatureVal = extractStringValue(valNode);
        sigLine = decl.startPosition.row + 1;
      } else if (varName === "$description") {
        descriptionVal = extractStringValue(valNode);
      }
    }

    if (signatureVal) {
      const id = mintId(`${rel}#command:${signatureVal}`, minted);
      const span = `L${sigLine}-L${sigLine}`;
      const sig = `command: ${signatureVal}` + (descriptionVal ? ` — ${descriptionVal}` : "");

      nodes.push({
        id,
        name: `command: ${signatureVal}`,
        kind: "endpoint",
        path: rel,
        span,
        signature: sig,
        exported: true,
        origin: "ast",
        body_hash: contentHash(cls.text),
        body_text: `Artisan Command '${signatureVal}': ${descriptionVal ?? ""}`,
        summary_state: "pending",
        summary: null,
        crux: null,
      });

      rawEdges.push({
        source: rel,
        relation: "contains",
        targetId: id,
        file: rel,
      });

      rawEdges.push({
        source: id,
        relation: "calls",
        name: clsName,
        kinds: ["class"],
        file: rel,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Eloquent Model Extractor (app/Models/*.php)                                */
/* -------------------------------------------------------------------------- */

const RELATION_METHODS = new Set([
  "hasOne",
  "hasMany",
  "belongsTo",
  "belongsToMany",
  "hasOneThrough",
  "hasManyThrough",
  "morphTo",
  "morphOne",
  "morphMany",
  "morphToMany",
  "morphedByMany",
]);

export function extractLaravelModel(
  rel: string,
  source: string,
  root: SyntaxNode,
  ctx: WalkCtx,
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  minted: Set<string>,
): void {
  function findClasses(node: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
    if (node.type === "class_declaration") out.push(node);
    for (const c of node.namedChildren) findClasses(c, out);
    return out;
  }

  const classes = findClasses(root);
  for (const cls of classes) {
    const baseClause = cls.namedChildren.find((c) => c.type === "base_clause");
    const isModel =
      (baseClause && /(?:Model|Authenticatable|Pivot)\b/.test(baseClause.text)) ||
      rel.includes("/Models/");
    if (!isModel) continue;

    const clsNameNode = cls.namedChildren.find((c) => c.type === "name");
    const clsName = clsNameNode?.text ?? basename(rel, ".php");
    const classNode = nodes.find((n) => n.name === clsName && n.kind === "class");
    const classId = classNode?.id ?? rel;

    const declList = cls.namedChildren.find((c) => c.type === "declaration_list");
    if (!declList) continue;

    let tableName: string | null = null;
    const fillableFields: string[] = [];

    for (const decl of declList.namedChildren) {
      if (decl.type === "property_declaration") {
        const propElem = decl.namedChildren.find((c) => c.type === "property_element");
        if (!propElem) continue;
        const varName = propElem.namedChildren.find((c) => c.type === "variable_name")?.text;
        if (varName === "$table") {
          const valNode = propElem.namedChildren.find(
            (c) => c.type === "string" || c.type === "encapsed_string",
          );
          tableName = extractStringValue(valNode);
        } else if (varName === "$fillable") {
          const arr = propElem.namedChildren.find((c) => c.type === "array_creation_expression");
          if (arr) {
            for (const el of arr.namedChildren) {
              if (el.type === "array_element_initializer") {
                const s = extractStringValue(el.namedChildren[0]);
                if (s) fillableFields.push(s);
              }
            }
          }
        }
      } else if (decl.type === "method_declaration") {
        const methodName = decl.namedChildren.find((c) => c.type === "name" || c.type === "identifier")?.text;
        if (!methodName) continue;

        function findMemberCalls(n: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
          if (n.type === "member_call_expression") out.push(n);
          for (const ch of n.namedChildren) findMemberCalls(ch, out);
          return out;
        }

        const calls = findMemberCalls(decl);
        for (const call of calls) {
          const callName = call.namedChildren.find((c) => c.type === "name" || c.type === "identifier")?.text;
          if (!callName || !RELATION_METHODS.has(callName)) continue;

          const args =
            call.namedChildren
              .find((c) => c.type === "arguments")
              ?.namedChildren.filter((c) => c.type === "argument") ?? [];

          let targetModel: string | null = null;
          let pivotTable: string | null = null;

          if (args.length > 0) {
            const arg0 = args[0];
            const constAccess =
              arg0.namedChildren.find((c) => c.type === "class_constant_access_expression") ||
              (arg0.type === "class_constant_access_expression" ? arg0 : null);

            if (constAccess) {
              const cName = constAccess.namedChildren[0]?.text;
              if (cName) targetModel = cName.split("\\").pop() || cName;
            } else {
              const strVal = extractStringValue(arg0);
              if (strVal) targetModel = strVal.split("\\").pop() || strVal;
            }
          }

          if (callName === "belongsToMany" && args.length > 1) {
            pivotTable = extractStringValue(args[1]);
          }

          if (targetModel) {
            const methodNode = nodes.find(
              (n) => n.name === methodName && (n.kind === "method" || n.kind === "function"),
            );
            const sourceId = methodNode?.id ?? classId;

            if (methodNode && !methodNode.signature?.includes("→")) {
              methodNode.signature = `${methodNode.signature ?? methodName} → ${targetModel}`;
            }

            rawEdges.push({
              source: sourceId,
              relation: "calls",
              name: targetModel,
              kinds: ["class"],
              file: rel,
            });

            if (pivotTable) {
              rawEdges.push({
                source: sourceId,
                relation: "calls",
                name: `table: ${pivotTable}`,
                kinds: ["type"],
                file: rel,
              });
            }
          }
        }
      }
    }

    if (tableName) {
      rawEdges.push({
        source: classId,
        relation: "calls",
        name: `table: ${tableName}`,
        kinds: ["type"],
        file: rel,
      });
    }

    if (classNode && fillableFields.length > 0) {
      classNode.body_text =
        (classNode.body_text ? `${classNode.body_text}\n` : "") +
        `Fillable: [${fillableFields.join(", ")}]`;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Seeder Extractor (database/seeders/*.php)                                  */
/* -------------------------------------------------------------------------- */

export function extractLaravelSeeders(
  rel: string,
  source: string,
  root: SyntaxNode,
  ctx: WalkCtx,
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  minted: Set<string>,
): void {
  function findClasses(node: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
    if (node.type === "class_declaration") out.push(node);
    for (const c of node.namedChildren) findClasses(c, out);
    return out;
  }

  const classes = findClasses(root);
  for (const cls of classes) {
    const clsNameNode = cls.namedChildren.find((c) => c.type === "name");
    const clsName = clsNameNode?.text ?? basename(rel, ".php");
    const classNode = nodes.find((n) => n.name === clsName && n.kind === "class");
    const classId = classNode?.id ?? rel;

    function findMemberCalls(n: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
      if (n.type === "member_call_expression") out.push(n);
      for (const ch of n.namedChildren) findMemberCalls(ch, out);
      return out;
    }

    const calls = findMemberCalls(cls);
    for (const call of calls) {
      const name = call.namedChildren.find((c) => c.type === "name" || c.type === "identifier")?.text;
      if (name === "call") {
        const calledClasses = findClassConstants(call);
        for (const called of calledClasses) {
          rawEdges.push({
            source: classId,
            relation: "calls",
            name: called,
            kinds: ["class"],
            file: rel,
          });
        }
      }
    }
  }
}
