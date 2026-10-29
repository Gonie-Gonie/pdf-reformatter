import type { PDFPageProxy } from 'pdfjs-dist';
import type { SourcePage, SourceStructure } from '../../core/model';

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type StructTreeNode = Awaited<ReturnType<PDFPageProxy['getStructTree']>>;

interface MarkedScope {
  markedContentId?: string;
  artifact?: boolean;
}

/** PDF.js emits tag and nullable id at runtime, although TextMarkedContent omits tag. */
interface MarkedToken {
  type: string;
  tag?: string | null;
  id?: string | null;
}

export function markedContentAt(items: TextContent['items']): Map<number, MarkedScope> {
  const metadata = new Map<number, MarkedScope>();
  const scopes: MarkedScope[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if ('str' in item) {
      const scope = scopes.at(-1);
      if (scope?.markedContentId || scope?.artifact) metadata.set(index, { ...scope });
      continue;
    }
    const token = item as MarkedToken;
    if (token.type === 'endMarkedContent') {
      scopes.pop();
      continue;
    }
    if (token.type !== 'beginMarkedContent' && token.type !== 'beginMarkedContentProps') continue;
    const parent = scopes.at(-1);
    const scope: MarkedScope = { ...parent };
    if (token.type === 'beginMarkedContentProps' && typeof token.id === 'string' && token.id)
      scope.markedContentId = token.id;
    if (token.tag === 'Artifact') scope.artifact = true;
    scopes.push(scope);
  }
  return metadata;
}

/** Optional structure supplements source text; unknown nodes never remove its geometry fallback. */
export function attachStructure(page: SourcePage, tree: StructTreeNode | null): void {
  delete page.structure;
  for (const item of page.items) delete item.structureRoles;
  if (!tree || typeof tree !== 'object') return;
  const byContent = new Map<string, typeof page.items>();
  for (const item of page.items) {
    if (!item.markedContentId || item.artifact) continue;
    const items = byContent.get(item.markedContentId) ?? [];
    items.push(item);
    byContent.set(item.markedContentId, items);
  }
  const structures: SourceStructure[] = [];
  const visited = new WeakSet<object>();
  let order = 0;
  const visit = (value: unknown, path: string, roles: string[], parentId?: string): string[] => {
    if (!value || typeof value !== 'object' || visited.has(value) || roles.length > 128) return [];
    visited.add(value);
    const node = value as Record<string, unknown>;
    if (typeof node.role !== 'string' || !Array.isArray(node.children)) {
      if (node.type !== 'content' || typeof node.id !== 'string') return [];
      const items = byContent.get(node.id) ?? [];
      for (const item of items) item.structureRoles ??= [...roles];
      return items.map((item) => item.id);
    }
    const id = `p${page.number}:structure:${path}`;
    const rolePath = [...roles, node.role];
    const group: SourceStructure = {
      id,
      role: node.role,
      sourceIds: [],
      order: order++,
      ...(parentId ? { parentId } : {}),
    };
    structures.push(group);
    group.sourceIds = [
      ...new Set(
        node.children.flatMap((child, index) => visit(child, `${path}.${index}`, rolePath, id)),
      ),
    ];
    return group.sourceIds;
  };
  visit(tree, 'root', []);
  const populated = structures.filter((group) => group.sourceIds.length);
  if (populated.length) page.structure = populated;
}
