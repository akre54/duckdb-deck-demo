import { describe, it, expect } from 'vitest';
import { OrbitCamera, perspective, lookAt, multiply, VIEW_UNIFORM_SIZE } from './camera.js';

/**
 * Pure math, and the highest-value-per-line tests in the suite: every failure mode here
 * renders a black screen with no error. The projection convention in particular — WebGPU
 * clips z to [0, 1], not OpenGL's [-1, 1] — silently discards every point if it is wrong,
 * which is exactly what happened while building this.
 */

/** Column-major mat4 times a column vector, matching WGSL's `m * v`. */
function transform(m: Float32Array, v: [number, number, number, number]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += m[k * 4 + row] * v[k];
    out[row] = sum;
  }
  return out;
}

const NEAR = 0.1;
const FAR = 100;

describe('perspective', () => {
  const p = perspective(Math.PI / 3, 16 / 9, NEAR, FAR);

  it('maps the near plane to depth 0 and the far plane to depth 1', () => {
    // The WebGPU convention. A GL-style matrix maps near to -1, and everything is clipped.
    const atNear = transform(p, [0, 0, -NEAR, 1]);
    const atFar = transform(p, [0, 0, -FAR, 1]);
    expect(atNear[2] / atNear[3]).toBeCloseTo(0, 5);
    expect(atFar[2] / atFar[3]).toBeCloseTo(1, 5);
  });

  it('keeps depth increasing with distance across the whole frustum', () => {
    let previous = -Infinity;
    for (const z of [NEAR, 1, 5, 25, 60, FAR]) {
      const clip = transform(p, [0, 0, -z, 1]);
      const depth = clip[2] / clip[3];
      expect(depth).toBeGreaterThan(previous);
      previous = depth;
    }
  });

  it('puts w equal to view-space distance, so perspective divide works', () => {
    expect(transform(p, [0, 0, -7, 1])[3]).toBeCloseTo(7, 5);
  });

  it('places a point behind the camera at negative w so it can be culled', () => {
    // The point and heatmap shaders both test `clip.w <= 0`.
    expect(transform(p, [0, 0, 5, 1])[3]).toBeLessThan(0);
  });

  it('applies aspect ratio to x only', () => {
    const wide = perspective(Math.PI / 3, 2, NEAR, FAR);
    const square = perspective(Math.PI / 3, 1, NEAR, FAR);
    expect(wide[0]).toBeCloseTo(square[0] / 2, 6);
    expect(wide[5]).toBeCloseTo(square[5], 6);
  });

  it('a narrower field of view magnifies', () => {
    const narrow = perspective(Math.PI / 8, 1, NEAR, FAR);
    const wide = perspective(Math.PI / 2, 1, NEAR, FAR);
    expect(narrow[5]).toBeGreaterThan(wide[5]);
  });

  it('maps the frustum edge to the clip-space edge', () => {
    const fovY = Math.PI / 3;
    const z = 10;
    const halfHeight = Math.tan(fovY / 2) * z;
    const edge = transform(perspective(fovY, 1, NEAR, FAR), [0, halfHeight, -z, 1]);
    expect(edge[1] / edge[3]).toBeCloseTo(1, 5);
  });
});

describe('lookAt', () => {
  it('puts the eye at the clip-space origin', () => {
    const eye: [number, number, number] = [3, 4, 5];
    const v = transform(lookAt(eye, [0, 0, 0], [0, 1, 0]), [...eye, 1]);
    expect(v[0]).toBeCloseTo(0, 5);
    expect(v[1]).toBeCloseTo(0, 5);
    expect(v[2]).toBeCloseTo(0, 5);
  });

  it('places the target in front of the camera, at negative z', () => {
    // Positive z would mean looking away from the target — another silent black screen.
    const v = transform(lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]), [0, 0, 0, 1]);
    expect(v[2]).toBeLessThan(0);
    expect(v[2]).toBeCloseTo(-5, 5);
  });

  it('has an orthonormal rotation block', () => {
    const m = lookAt([2, 3, 4], [1, 0, -1], [0, 1, 0]);
    const rows: [number, number, number][] = [
      [m[0], m[4], m[8]],
      [m[1], m[5], m[9]],
      [m[2], m[6], m[10]],
    ];
    for (const r of rows) expect(Math.hypot(...r)).toBeCloseTo(1, 5);
    // Pairwise orthogonal.
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(rows[0], rows[1])).toBeCloseTo(0, 5);
    expect(dot(rows[0], rows[2])).toBeCloseTo(0, 5);
    expect(dot(rows[1], rows[2])).toBeCloseTo(0, 5);
  });

  it('preserves distances, being a rigid transform', () => {
    const m = lookAt([5, 5, 5], [0, 0, 0], [0, 1, 0]);
    const a = transform(m, [1, 2, 3, 1]);
    const b = transform(m, [4, 0, -2, 1]);
    const moved = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(moved).toBeCloseTo(Math.hypot(1 - 4, 2 - 0, 3 + 2), 4);
  });

  it('survives looking straight down, where up is parallel to the view', () => {
    // The cross product degenerates here; without a fallback every element becomes NaN.
    const m = lookAt([0, 5, 0], [0, 0, 0], [0, 1, 0]);
    expect([...m].every(Number.isFinite)).toBe(true);
    const v = transform(m, [0, 0, 0, 1]);
    expect(v.every(Number.isFinite)).toBe(true);
  });

  it('is the identity rotation when looking down -z with y up', () => {
    const m = lookAt([0, 0, 0], [0, 0, -1], [0, 1, 0]);
    expect(m[0]).toBeCloseTo(1, 6);
    expect(m[5]).toBeCloseTo(1, 6);
    expect(m[10]).toBeCloseTo(1, 6);
  });
});

describe('multiply', () => {
  it('is the identity when one side is the identity', () => {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const m = lookAt([1, 2, 3], [0, 0, 0], [0, 1, 0]);
    expect([...multiply(identity, m)]).toEqual([...m]);
    expect([...multiply(m, identity)]).toEqual([...m]);
  });

  it('agrees with applying the matrices in sequence', () => {
    // proj * view applied at once must equal view then proj — the composition order the
    // camera relies on.
    const view = lookAt([0, 0, 6], [0, 0, 0], [0, 1, 0]);
    const proj = perspective(Math.PI / 3, 1.5, NEAR, FAR);
    const point: [number, number, number, number] = [1, -2, 0, 1];
    const composed = transform(multiply(proj, view), point);
    const sequential = transform(proj, transform(view, point));
    for (let i = 0; i < 4; i++) expect(composed[i]).toBeCloseTo(sequential[i], 4);
  });

  it('is not commutative, so argument order is load-bearing', () => {
    const view = lookAt([0, 0, 6], [0, 0, 0], [0, 1, 0]);
    const proj = perspective(Math.PI / 3, 1.5, NEAR, FAR);
    expect([...multiply(proj, view)]).not.toEqual([...multiply(view, proj)]);
  });
});

describe('OrbitCamera', () => {
  it('places the eye at the requested distance from the target', () => {
    const cam = new OrbitCamera();
    cam.state.target = [1, 2, 3];
    cam.state.distance = 7;
    const [x, y, z] = cam.eye();
    expect(Math.hypot(x - 1, y - 2, z - 3)).toBeCloseTo(7, 5);
  });

  it('pitch raises the eye and yaw sweeps it horizontally', () => {
    const cam = new OrbitCamera();
    cam.state.target = [0, 0, 0];
    cam.state.distance = 10;
    cam.state.pitch = 0;
    cam.state.yaw = 0;
    expect(cam.eye()[1]).toBeCloseTo(0, 5);
    expect(cam.eye()[2]).toBeCloseTo(10, 5);

    cam.state.pitch = Math.PI / 2;
    expect(cam.eye()[1]).toBeCloseTo(10, 5);

    cam.state.pitch = 0;
    cam.state.yaw = Math.PI / 2;
    expect(cam.eye()[0]).toBeCloseTo(10, 5);
  });

  it('frames the mercator world box by default', () => {
    // The default distance must actually show data normalized to about one world unit;
    // a default of 2.2 left it as a speck.
    const cam = new OrbitCamera();
    const visibleHeight = 2 * cam.state.distance * Math.tan(cam.state.fovY / 2);
    expect(visibleHeight).toBeGreaterThan(0.3);
    expect(visibleHeight).toBeLessThan(3);
  });

  it('packs exactly the uniform the shaders declare', () => {
    const cam = new OrbitCamera();
    const packed = cam.pack(1600, 900);
    expect(packed.length).toBe(VIEW_UNIFORM_SIZE / 4);
    expect(VIEW_UNIFORM_SIZE).toBe(96);
    // mat4 occupies 0..15, eye is 16..19, viewport is 20..23.
    expect([...packed.slice(16, 19)]).toEqual(cam.eye().map((v) => Math.fround(v)));
    expect(packed[19]).toBe(1);
    expect(packed[20]).toBe(1600);
    expect(packed[21]).toBe(900);
    expect([...packed].every(Number.isFinite)).toBe(true);
  });

  it('reuses one scratch array, so callers must copy if they retain it', () => {
    const cam = new OrbitCamera();
    const first = cam.pack(100, 100);
    const second = cam.pack(200, 200);
    expect(first).toBe(second);
    expect(first[20]).toBe(200);
  });

  it('projects the target to the centre of the view', () => {
    const cam = new OrbitCamera();
    cam.state.target = [0.25, 0, -0.1];
    const vp = cam.pack(800, 600).slice(0, 16);
    const clip = transform(vp as Float32Array, [...cam.state.target, 1]);
    expect(clip[0] / clip[3]).toBeCloseTo(0, 4);
    expect(clip[1] / clip[3]).toBeCloseTo(0, 4);
  });

  it('keeps the target inside the depth range at the default framing', () => {
    const cam = new OrbitCamera();
    const vp = cam.pack(800, 600).slice(0, 16);
    const clip = transform(vp as Float32Array, [0, 0, 0, 1]);
    const depth = clip[2] / clip[3];
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(1);
  });

  it('starts at version 0 so the first frame always uploads', () => {
    // `Runtime` compares against -1 initially; a non-zero start would skip the first write.
    expect(new OrbitCamera().version).toBe(0);
  });
});
