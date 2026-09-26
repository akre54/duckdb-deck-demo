import { useEffect, useRef } from 'react';
import { useEditor } from '../store.js';
import type { Engine } from '../engine.js';

export function Viewport({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLDivElement>(null);
  const runtime = useEditor((s) => s.runtime);
  const credits = useEditor((s) => s.doc.credits);
  useEffect(() => { if (ref.current) engine.attachMap(ref.current); }, [engine]);
  const r = runtime.report;
  const c = runtime.counters;
  return (
    <div className="viewport">
      <div className="map" ref={ref} />
      <div className="overlay-info">
        {runtime.layers.map((l) => (
          <div key={l.id}>{l.id} · {l.plan.kind} · {l.data?.rows.toLocaleString() ?? '—'}{l.error ? ' · error' : ''}</div>
        ))}
        {r && (
          <div style={{ marginTop: 4, color: '#7f889c' }}>
            last {r.kind === 'graph' ? 'compile' : 'update'}: {r.rematerialized} materialized · {r.requeried.length} requeried · {r.evaluated.length} cpu · {r.ms.toFixed(0)} ms
          </div>
        )}
        {c && <div style={{ color: '#7f889c' }}>props applied {c.propUpdates} · queries {c.requeries} · cpu passes {c.evaluations}</div>}
      </div>
      {credits?.length ? <div className="credits">{credits.join(' · ')}</div> : null}
    </div>
  );
}
