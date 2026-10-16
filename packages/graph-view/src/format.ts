import type { GraphMetric } from './schema.js';

/** A metric as short display text: `1.2 ms`, `4.0 MB`, `16`. */
export function formatMetric(metric: GraphMetric): string {
  const text = formatValue(metric.value, metric.unit);
  return metric.p95 === undefined ? text : `${text} (p95 ${formatValue(metric.p95, metric.unit)})`;
}

function formatValue(value: number, unit: GraphMetric['unit']): string {
  if (unit === 'ms') return value < 0.1 ? `${(value * 1000).toFixed(0)} µs` : `${value.toFixed(value < 10 ? 2 : 1)} ms`;
  if (unit === 'bytes') {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  }
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
}
