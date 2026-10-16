import { describe, it, expect } from 'vitest';
import { stepNames } from './graph-description.js';

describe('stepNames', () => {
  it('names a filter’s passes by step, keeping only the numbers that differ', () => {
    // One batch, so `batch 0` is on every pass and says nothing; the scan levels differ.
    const names = stepNames([
      'upload-controls',
      'visibility-batch-0-identity',
      'predicate-batch-0',
      'visibility-batch-0-compact-scan-level-0-scan',
      'visibility-batch-0-compact-scan-level-1-scan',
      'visibility-batch-0-compact-scan-level-0-add-offsets',
      'visibility-batch-0-compact-scatter',
    ]);
    expect([...names.values()]).toEqual([
      'upload controls',
      'identity',
      'predicate',
      'scan · level 0',
      'scan · level 1',
      'add offsets · level 0',
      'compact scatter',
    ]);
  });

  it('keeps the batch when there are several, and reads a step that comes before its last index', () => {
    const names = stepNames([
      'predicate-batch-0', 'predicate-batch-1',
      'group-values-0-finite-chunk-0',
      'group-metric-0-chunk-0-local', 'group-metric-1-chunk-0-mean',
    ]);
    expect([...names.values()]).toEqual([
      'predicate · batch 0', 'predicate · batch 1',
      'finite',
      'local · metric 0', 'mean · metric 1',
    ]);
  });

  it('leaves an id with no indices as its words', () => {
    expect(stepNames(['clear-bins', 'accumulate']).get('clear-bins')).toBe('clear bins');
  });
});
