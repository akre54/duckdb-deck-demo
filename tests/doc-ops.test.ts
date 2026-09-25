import { describe, it, expect } from 'vitest';
import { lowerDocument, canonicalJson, type EditorDoc } from '@noodles.gl/planner';
import { collapseToSubnet, insertOnEdge, connect, validConnection, promote, setKey, removeKey, renameNode } from '../demo/editor/doc-ops.js';
import earthquakesJson from '../demo/editor/examples/earthquakes.json';

const earthquakes = () => structuredClone(earthquakesJson) as unknown as EditorDoc;
const graphOf = (doc: EditorDoc) => canonicalJson(lowerDocument(doc).graph);

describe('editor document operations', () => {
  it('collapsing nodes into a subnet leaves the lowered graph byte-identical', () => {
    const flat = earthquakes();
    const nested = earthquakes();
    const sub = collapseToSubnet(nested, ['strong', 'pos', 'size']);
    expect(sub?.name).toBe('subnet1');
    expect(lowerDocument(nested).errors).toEqual([]);
    const a = lowerDocument(flat).graph;
    const b = lowerDocument(nested).graph;
    expect(b.nodes.map((n) => n.id)).toEqual(a.nodes.map((n) => n.id));
    expect(canonicalJson(b.params)).toBe(canonicalJson(a.params));
    expect(graphOf(nested)).toBe(graphOf(flat));
  });

  it('rewrites references when a node moves into a subnet or is renamed', () => {
    const doc = earthquakes();
    collapseToSubnet(doc, ['size']);
    // `size` now lives inside the subnet, so its sibling reference became absolute.
    expect(doc.nodes.find((n) => n.id === 'size')!.params.inMin).toEqual({ ref: '/min_mag/value' });
    renameNode(doc, 'threshold', 'cutoff');
    expect(doc.nodes.find((n) => n.id === 'size')!.params.inMin).toEqual({ ref: '/cutoff/value' });
    expect(lowerDocument(doc).graph.params!.size__inMin.value).toBe(2.5);
  });

  it('a promoted parameter drives its child from the subnet', () => {
    const doc = earthquakes();
    const sub = collapseToSubnet(doc, ['size'])!;
    promote(doc, 'size', 'outMax', 30);
    const lowered = lowerDocument(doc);
    expect(lowered.graph.params!.size__outMax.value).toBe(30);
    expect(sub.promoted?.[0]).toMatchObject({ node: 'size', param: 'outMax' });
  });

  it('inserts a node on a wire, keeping both ends connected', () => {
    const doc = earthquakes();
    const n = insertOnEdge(doc, 'e3', 'range')!;
    expect(doc.edges.find((e) => e.target === n.id)?.source).toBe('strong');
    expect(doc.edges.find((e) => e.source === n.id)?.target).toBe('pos');
    expect(doc.edges.some((e) => e.id === 'e3')).toBe(false);
  });

  it('refuses a wire that would make a cycle or join mismatched types', () => {
    const doc = earthquakes();
    expect(validConnection(doc, 'dots', 'out', 'strong', 'in')).toBe(false); // layer -> table
    expect(validConnection(doc, 'pos', 'out', 'strong', 'in')).toBe(false); // cycle
    expect(validConnection(doc, 'threshold', 'out', 'size', 'par:inMax')).toBe(true);
    connect(doc, 'threshold', 'out', 'size', 'par:inMax');
    expect(lowerDocument(doc).references).toContainEqual({ from: 'threshold.out', to: 'size.inMax' });
  });

  it('keys and unkeys a parameter on the timeline', () => {
    const doc = earthquakes();
    setKey(doc, 'dots.radiusScale', 0, 1);
    setKey(doc, 'dots.radiusScale', 2, 5);
    expect(doc.timeline!.tracks[0].keyframes.map((k) => k.value)).toEqual([1, 5]);
    const lowered = lowerDocument(doc);
    expect(lowered.scalars.animated('dots.radiusScale')).toBe(true);
    removeKey(doc, 'dots.radiusScale', 2);
    expect(doc.timeline!.tracks[0].keyframes).toHaveLength(1);
  });
});
