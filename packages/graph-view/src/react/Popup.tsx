import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { GraphEdge } from '../schema.js';
import type { NodePreview } from '../preview.js';
import { formatMetric } from '../format.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** A floating box at a point inside the viewer, kept on screen. */
export function Popup({ x, y, bounds, children }: { x: number; y: number; bounds: DOMRect; children: ReactNode }) {
  // Open to the side with more room, so a popup near the right or bottom edge is not cut off.
  const style: CSSProperties = {
    position: 'absolute', zIndex: 10, pointerEvents: 'none', maxWidth: Math.min(360, bounds.width - 16),
    background: '#10131aee', border: '1px solid #2a2f3a', borderRadius: 6, padding: '6px 8px',
    color: '#e5e7eb', font: `11px/1.4 ${MONO}`, boxShadow: '0 6px 20px #0008',
    ...(x > bounds.width / 2 ? { right: bounds.width - x + 12 } : { left: x + 12 }),
    ...(y > bounds.height / 2 ? { bottom: bounds.height - y + 12 } : { top: y + 12 }),
  };
  return <div style={style}>{children}</div>;
}

/** A producer's preview of a node: a table of values, an image, or text. */
export function PreviewView({ title, preview }: { title: string; preview: NodePreview | 'loading' | undefined }) {
  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 4, overflowWrap: 'anywhere' }}>{title}</div>
      {preview === 'loading' && <div style={{ color: '#9ca3af' }}>reading…</div>}
      {preview === undefined && <div style={{ color: '#9ca3af' }}>no preview</div>}
      {preview && preview !== 'loading' && preview.kind === 'text' && <div>{preview.text}</div>}
      {preview && preview !== 'loading' && preview.kind === 'table' && <Table preview={preview} />}
      {preview && preview !== 'loading' && preview.kind === 'image' && <Image preview={preview} />}
      {preview && preview !== 'loading' && preview.kind !== 'text' && preview.note && (
        <div style={{ color: '#9ca3af', marginTop: 4 }}>{preview.note}</div>
      )}
    </>
  );
}

function Table({ preview }: { preview: Extract<NodePreview, { kind: 'table' }> }) {
  const cell: CSSProperties = { padding: '0 6px 0 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  return (
    <>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>{preview.columns.map((c) => <th key={c} style={{ ...cell, color: '#9ca3af', fontWeight: 500 }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={cell}>{String(v)}</td>)}</tr>)}
        </tbody>
      </table>
      {preview.total !== undefined && preview.total > preview.rows.length && (
        <div style={{ color: '#9ca3af', marginTop: 2 }}>
          {preview.rows.length} of {preview.total.toLocaleString('en-US')}
        </div>
      )}
    </>
  );
}

/** RGBA bytes on a canvas, scaled up without smoothing so texels stay visible. */
function Image({ preview }: { preview: Extract<NodePreview, { kind: 'image' }> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(preview.rgba, preview.width, preview.height), 0, 0);
  }, [preview]);
  // Shown 256px on its long side: a small texture scaled up, a large one scaled down.
  const scale = 256 / Math.max(preview.width, preview.height);
  return (
    <>
      <canvas
        ref={canvas} width={preview.width} height={preview.height}
        style={{ display: 'block', width: preview.width * scale, height: preview.height * scale, imageRendering: 'pixelated' }}
      />
      <div style={{ color: '#9ca3af', marginTop: 2 }}>{preview.width}×{preview.height}</div>
    </>
  );
}

/** What an edge carries: its kind and every metric and attribute the producer gave it. */
export function EdgeTip({ edge, from, to }: { edge: GraphEdge; from: string; to: string }) {
  const rows: [string, string][] = [
    ...Object.entries(edge.metrics ?? {}).map(([k, m]) => [k, formatMetric(m)] as [string, string]),
    ...Object.entries(edge.attributes ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
  ];
  return (
    <>
      <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{edge.kind ?? 'edge'}{edge.label ? `: ${edge.label}` : ''}</div>
      <div style={{ color: '#9ca3af', overflowWrap: 'anywhere' }}>{from} → {to}</div>
      {rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0 10px', marginTop: 3 }}>
          {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><span style={{ color: '#9ca3af' }}>{k}</span><span>{v}</span></div>)}
        </div>
      )}
    </>
  );
}

/** Which color means what, and that width is bytes. */
export function Legend({ colors }: { colors: Record<string, string> }) {
  return (
    <div style={{
      position: 'absolute', right: 10, bottom: 10, zIndex: 5, pointerEvents: 'none',
      background: '#10131acc', border: '1px solid #2a2f3a', borderRadius: 6, padding: '5px 8px',
      font: `10px/1.5 ${MONO}`, color: '#cbd5e1',
    }}>
      {Object.entries(colors).map(([kind, color]) => (
        <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={color} strokeWidth="2" strokeDasharray={kind === 'dependency' ? '4 3' : undefined} /></svg>
          {kind}
        </div>
      ))}
      <div style={{ color: '#9ca3af' }}>width: bytes (log)</div>
    </div>
  );
}
