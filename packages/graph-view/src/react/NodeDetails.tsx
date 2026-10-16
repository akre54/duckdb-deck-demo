import type { CSSProperties } from 'react';
import type { GraphNode } from '../schema.js';
import { formatMetric } from '../format.js';

/** Every metric and attribute of one node, as a key/value table. Pairs with `GraphView`'s selection. */
export function NodeDetails({ node, style }: { node: GraphNode | undefined; style?: CSSProperties }) {
  if (!node) return null;
  const rows: [string, string][] = [
    ['id', node.id],
    ['kind', node.kind],
    ...(node.group ? [['group', node.group] as [string, string]] : []),
    ...(node.order !== undefined ? [['order', String(node.order)] as [string, string]] : []),
    ...Object.entries(node.metrics ?? {}).map(([k, m]) => [k, formatMetric(m)] as [string, string]),
    ...Object.entries(node.attributes ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
  ];
  return (
    <dl style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: 0,
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e5e7eb', ...style,
    }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: '#9ca3af' }}>{k}</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
