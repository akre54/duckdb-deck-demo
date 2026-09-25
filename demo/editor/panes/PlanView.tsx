import { Fragment } from 'react';
import { useEditor } from '../store.js';

/**
 * What the graph compiled to: every relation with its memo key and SQL, every layer with its
 * placement and query, and the counters that say what the last change actually cost.
 */
export function PlanView() {
  const runtime = useEditor((s) => s.runtime);
  const program = runtime.program;
  if (!program) return <div className="planview"><div className="card">Not compiled yet.</div></div>;
  const c = runtime.counters;
  const k = runtime.catalog;
  return (
    <div className="planview">
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h5>Runtime <span className="k">memo + routes</span></h5>
        <div className="counters">
          <span>compiles <b>{c?.compiles ?? 0}</b></span>
          <span>relations materialized <b>{k?.materialized ?? 0}</b></span>
          <span>memo hits <b>{k?.hits ?? 0}</b></span>
          <span>evicted <b>{k?.dropped ?? 0}</b></span>
          <span>layer queries <b>{c?.requeries ?? 0}</b></span>
          <span>cpu passes <b>{c?.evaluations ?? 0}</b></span>
          <span>prop-only updates <b>{c?.propUpdates ?? 0}</b></span>
        </div>
        {program.errors.length > 0 && (
          <pre className="code" style={{ color: 'var(--warn)' }}>{program.errors.map((e) => `${e.nodeId}: ${e.message}`).join('\n')}</pre>
        )}
      </div>
      {program.relations.map((r) => (
        <div className="card" key={r.id}>
          <h5>{r.id} <span className="k">{r.kind} · {r.materialize ? 'materialized' : 'inlined'}</span></h5>
          <dl className="kv">
            <dt>hash</dt><dd>{r.hash}</dd>
            <dt>rows</dt><dd>{r.rows?.toLocaleString() ?? '—'}</dd>
            <dt>reads</dt><dd>{r.inputs.join(', ') || '—'}</dd>
            <dt>read by</dt><dd>{r.consumers.join(', ')}</dd>
            {r.params.length > 0 && <><dt>inlines</dt><dd>{r.params.join(', ')}</dd></>}
          </dl>
          <pre className="code">{r.sql}</pre>
        </div>
      ))}
      {program.layers.map((l) => (
        <div className="card" key={l.id}>
          <h5>{l.id} <span className="k">{l.kind} layer · {l.plan.explain.method} · reads {l.relation}</span></h5>
          <dl className="kv">
            {l.plan.explain.placement.map((p) => <Fragment key={p.nodeId}><dt>{p.nodeId}</dt><dd>{p.stage} · {p.why}</dd></Fragment>)}
            {l.plan.sqlParams.length > 0 && <><dt>binds</dt><dd>{l.plan.sqlParams.join(', ')}</dd></>}
          </dl>
          <pre className="code">{l.plan.sql}</pre>
        </div>
      ))}
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h5>Parameter routes</h5>
        <dl className="kv">
          {Object.entries(program.routes).map(([p, rs]) => <Fragment key={p}><dt>{p}</dt><dd>{rs.map((r) => `${r.route} → ${r.target}`).join(' · ')}</dd></Fragment>)}
        </dl>
      </div>
    </div>
  );
}
