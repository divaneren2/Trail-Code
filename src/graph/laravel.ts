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

function searchBody(text: string, max = 500): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

export function extractStringValue(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
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

  nodes[0].body_text = searchBody(source, 2000);
  return { nodes, rawEdges };
}
