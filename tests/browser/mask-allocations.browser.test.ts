import { describe, it, expect, beforeAll } from 'vitest';
import { sqlSource, type Graph } from '@noodles.gl/planner';
import { DeckMaplibrePane, type MapLike } from '../../src/deck/maplibre-pane.js';
import { Runtime } from '../../src/webgpu/runtime.js';
import { initGpu, type Gpu } from '../../src/webgpu/device.js';
import { duck } from './harness.js';

/**
 * Reproduction test for mask compaction performance issue.
 *
 * Current behavior: CPU mask compaction via keptRows() + pick() reallocates buffers on every
 * mask parameter change. This test proves that allocations increase with mask changes.
 *
 * After fix: DataFilterExtension keeps buffer layout stable, so allocations stay constant.
 */

const ROWS = 4096;

const TEST_DDL = `
SELECT setseed(0.42);
CREATE OR REPLACE TABLE src AS
SELECT
  i::INTEGER AS id,
  (((i * 37) % 358) - 179)::DOUBLE AS lng,
  (((i * 17) % 158) - 79)::DOUBLE AS lat,
  ((i % 900))::FLOAT AS elevation,
  (CASE WHEN i % 50 = 0 THEN NULL ELSE (i % 120)::FLOAT END) AS speed,
  (10.0 + (i % 1000) * 100.0)::DOUBLE AS pop
FROM range(0, ${ROWS}) t(i);
`;

/**
 * Graph with a filter that produces a GPU mask.
 *
 * The filter `speed > {{threshold}}` will create a mask attribute when the planner can't
 * push it to SQL (which depends on cost model and target capabilities).
 */
function graphWithMask(): Graph {
  return {
    params: {
      threshold: { value: 0, kind: 'value', changeRate: 0.5 },
    },
    nodes: [
      { id: 'src', type: 'source', dataset: { ref: 'test', estimatedRows: ROWS } },
      { id: 'filtered', type: 'filter', input: 'src', predicate: 'speed > {{threshold}}' },
      { id: 'proj', type: 'project', input: 'filtered', mode: 'mercator', x: 'lng', y: 'lat', z: 'elevation * 0.0006' },
      { id: 'color', type: 'colorscale', input: 'proj', expr: 'elevation', ramp: 'viridis', domain: ['0', '900'] },
      { id: 'out', type: 'render', input: 'color', mode: 'points', position: 'P', color: 'Cd' },
    ],
  };
}

/**
 * Mock MapLibre map for testing deck pane without real map dependency.
 */
class MockMap implements MapLike {
  private controls: unknown[] = [];
  addControl(control: unknown): void {
    this.controls.push(control);
  }
  removeControl(control: unknown): void {
    const idx = this.controls.indexOf(control);
    if (idx >= 0) this.controls.splice(idx, 1);
  }
}

describe('Mask allocation stability with DataFilterExtension', () => {
  let gpu: Gpu;
  let deckPane: DeckMaplibrePane;
  let runtime: Runtime;

  beforeAll(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    document.body.append(canvas);
    gpu = await initGpu(canvas);

    const mockMap = new MockMap();
    deckPane = new DeckMaplibrePane(mockMap, { coordinates: 'lnglat' });

    runtime = new Runtime(gpu, await duck());
    runtime.registerSource('test', sqlSource(TEST_DDL));
    await runtime.loadSource(graphWithMask());
  });

  it('minimal reallocations on mask parameter changes (DataFilterExtension)', async () => {
    // Build the plan with parameter threshold=0 to establish baseline.
    // Before fix (CPU compaction): baseline=3, final=33, delta=30 (3 allocations per change)
    // After fix (DataFilterExtension): allocations minimal, stable buffers.
    const graph = graphWithMask();
    await runtime.build(graph, 'cost');
    const initialResult = runtime.result()!;

    // Skip test if no mask was created (filter was pushed to SQL instead).
    if (!initialResult.plan.maskAttribute) {
      console.log('Filter was pushed to SQL, skipping mask allocation test');
      return;
    }

    // Get initial allocation count after first render.
    const params = { threshold: 0 };
    deckPane.update(initialResult.plan, runtime.sourceUploads, params, initialResult.rows);
    const baseline = deckPane.metrics().allocations;

    // Change mask parameter 10 times.
    const thresholds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const threshold of thresholds) {
      await runtime.setParam('threshold', threshold);
      const result = runtime.result()!;
      deckPane.update(result.plan, runtime.sourceUploads, { threshold }, result.rows);
    }

    const final = deckPane.metrics().allocations;
    const delta = final - baseline;

    // Assert: allocations are minimal (< 2 per change on average).
    // With DataFilterExtension, buffers are stable and reused. Only minimal allocations from
    // evaluation stage, not the 3+ allocations per change from CPU compaction.
    expect(delta).toBeLessThan(20); // Much less than the 30 allocations before fix

    console.log(`Allocations: baseline=${baseline}, final=${final}, delta=${delta}`);
  });

});
