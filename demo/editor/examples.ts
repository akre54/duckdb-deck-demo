import type { EditorDoc } from '@noodles.gl/planner';
import earthquakes from './examples/earthquakes.json';
import network from './examples/network.json';
import trips from './examples/trips.json';
import arrivals from './examples/arrivals.json';

/** The bundled examples, keyed by the `#example=` hash. JSON imports need the cast. */
export const EXAMPLES: Record<string, { label: string; doc: EditorDoc }> = {
  earthquakes: { label: 'USGS earthquakes', doc: earthquakes as unknown as EditorDoc },
  network: { label: 'Airport route network', doc: network as unknown as EditorDoc },
  trips: { label: 'Taxi trips + demand grid', doc: trips as unknown as EditorDoc },
  arrivals: { label: 'Airport arrivals replay', doc: arrivals as unknown as EditorDoc },
};

export const DEFAULT_EXAMPLE = 'network';
