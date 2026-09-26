import { memo } from 'react';
import { Handle, Position, useConnection, type NodeProps, type Node } from '@xyflow/react';
import { OPERATOR_INDEX, type DocNode, type PortType } from '@noodles.gl/planner';

export interface OpNodeData extends Record<string, unknown> {
  doc: DocNode;
  /** Badges: engines, memo, rows. */
  badges: { text: string; kind: string; title?: string }[];
  error?: string;
  /** Param ports that currently have a wire. */
  wiredParams: string[];
}

export type OpFlowNode = Node<OpNodeData, 'op'>;

export const CATEGORY_COLORS: Record<string, string> = {
  data: 'var(--cat-data)', table: 'var(--cat-table)', rows: 'var(--cat-rows)', color: 'var(--cat-color)',
  layer: 'var(--cat-layer)', output: 'var(--cat-output)', number: 'var(--cat-number)', structure: 'var(--cat-structure)',
};

/**
 * One operator on the canvas: a header coloured by category, table/layer ports as rows, and
 * parameter ports that appear only when they are wired — or while a number is being dragged,
 * when every parameter that can take one offers itself as a drop target. That keeps nodes
 * compact the way Houdini's are, without hiding what a number can drive.
 */
export const OpNode = memo(function OpNode({ data, selected }: NodeProps<OpFlowNode>) {
  const node = data.doc;
  const def = OPERATOR_INDEX.get(node.op);
  const connection = useConnection();
  const draggingType = connection.inProgress ? handleType(connection.fromHandle?.id ?? '', connection.fromNode?.data as OpNodeData | undefined, connection.fromHandle?.type) : undefined;
  if (!def) return <div className="opnode error">unknown operator {node.op}</div>;

  const portable = def.params.filter((p) => p.port);
  const showParams = portable.filter((p) => data.wiredParams.includes(p.name) || draggingType === 'number');
  const cls = [
    'opnode',
    selected && 'selected',
    data.error && 'error',
    node.flags?.bypass && 'bypassed',
    node.flags?.display && 'displayed',
  ].filter(Boolean).join(' ');
  const dim = (t: PortType | 'param', side: 'in' | 'out') => {
    if (!draggingType) return '';
    // Dragging from an output highlights inputs of that type, and vice versa.
    const fromOut = connection.fromHandle?.type === 'source';
    if (fromOut && side === 'in') return t === draggingType || (t === 'param' && draggingType === 'number') ? '' : 'dim';
    if (!fromOut && side === 'out') return t === draggingType || (draggingType === 'param' && t === 'number') ? '' : 'dim';
    return 'dim';
  };

  return (
    <div className={cls} title={data.error}>
      <div className="ohead" style={{ background: CATEGORY_COLORS[def.category] }}>
        <span className="oname">{node.name ?? node.id}</span>
        <span className="otype">{def.label}</span>
      </div>
      <div className="obody">
        {def.inputs.map((p) => (
          <div className="oport" key={`in-${p.name}`}>
            <Handle type="target" position={Position.Left} id={p.name} className={`${p.type} ${dim(p.type, 'in')}`} />
            {p.label ?? p.name}{p.multi ? ' …' : ''}
          </div>
        ))}
        {showParams.map((p) => (
          <div className="oport param" key={`par-${p.name}`}>
            <Handle type="target" position={Position.Left} id={`par:${p.name}`} className={`param ${dim('param', 'in')}`} />
            {p.label}
          </div>
        ))}
        {def.outputs.map((p) => (
          <div className="oport out" key={`out-${p.name}`}>
            {p.type === 'table' ? 'rows' : p.type}
            <Handle type="source" position={Position.Right} id={p.name} className={`${p.type} ${dim(p.type, 'out')}`} />
          </div>
        ))}
        {data.badges.length > 0 && (
          <div className="obadges">
            {data.badges.map((b) => <span key={b.text} className={`obadge ${b.kind}`} title={b.title}>{b.text}</span>)}
          </div>
        )}
        {data.error && <div className="oerr">{data.error}</div>}
      </div>
    </div>
  );
});

/** The type of the handle a connection is being dragged from. */
function handleType(handleId: string, data: OpNodeData | undefined, side: 'source' | 'target' | undefined): PortType | 'param' | undefined {
  if (!data) return undefined;
  if (handleId.startsWith('par:')) return 'param';
  const def = OPERATOR_INDEX.get(data.doc.op);
  const ports = side === 'source' ? def?.outputs : def?.inputs;
  return ports?.find((p) => p.name === handleId)?.type;
}
