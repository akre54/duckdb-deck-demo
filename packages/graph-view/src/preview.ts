/**
 * What a producer shows when a node is hovered: its contents, read on demand.
 *
 * Separate from the description because it is not part of the graph. It is read when asked for,
 * often from the GPU, and it is stale a frame later. Plain data like the description, so a
 * producer in a worker or another process can answer, and an image is RGBA bytes rather than a
 * canvas so this entry stays free of the DOM.
 */
export type NodePreview =
  | {
    kind: 'table';
    columns: string[];
    rows: (string | number)[][];
    /** Rows shown out of how many there are, for "16 of 1,048,576". */
    total?: number;
    note?: string;
  }
  | {
    kind: 'image';
    width: number;
    height: number;
    /** `width * height * 4` bytes, row-major, top row first. */
    rgba: Uint8ClampedArray<ArrayBuffer>;
    note?: string;
  }
  | { kind: 'text'; text: string };
