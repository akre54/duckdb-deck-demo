import { describe, it, expect } from 'vitest';
import { pointsShader, STYLE_UNIFORM_SIZE, type PointsBindings } from './points.js';
import { WEIGHT_FIXED_POINT } from './bin2d.js';
import type { GpuAttribute } from '../attributes.js';

/**
 * The render shaders are generated per-plan so that only the attributes which exist get
 * bound — no dummy buffers, no "is this channel present" flags. That makes them string
 * generators, and therefore testable in Node without a device.
 *
 * These assert the properties that make the output *compilable and bindable*: contiguous slot
 * numbering that matches what `PointsPass` binds, correct width handling, and the guards
 * against NaN and behind-camera geometry. Whether it draws the right pixels is the browser
 * suite's job.
 */

const attribute = (name: string, width: number): GpuAttribute => ({
  name, width, buffer: {} as GPUBuffer, capacityRows: 100, rows: 100, provenance: 'derived',
});

const bindings = (extra: Partial<PointsBindings> = {}): PointsBindings => ({
  position: attribute('P', 3), ...extra,
});

const slotsOf = (code: string) => [...code.matchAll(/@binding\((\d+)\)/g)].map((m) => Number(m[1]));

describe('binding layout', () => {
  it('reserves slots 0 and 1 for the view and style uniforms', () => {
    const code = pointsShader(bindings());
    expect(code).toMatch(/@binding\(0\)\s+var<uniform> view/);
    expect(code).toMatch(/@binding\(1\)\s+var<uniform> style/);
  });

  it('numbers storage bindings contiguously from 2', () => {
    // `PointsPass.resolveBindGroup` assigns entries in the same order starting at 2, so a gap
    // or a repeat here is a bind-group mismatch at pipeline creation.
    const code = pointsShader(bindings({
      color: attribute('Cd', 3), size: attribute('pscale', 1),
      opacity: attribute('Alpha', 1), mask: attribute('__mask', 1),
    }));
    expect(slotsOf(code)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('omits absent channels entirely rather than binding placeholders', () => {
    const code = pointsShader(bindings());
    expect(slotsOf(code)).toEqual([0, 1, 2]);
    expect(code).not.toContain('b_col');
    expect(code).not.toContain('b_siz');
    expect(code).not.toContain('b_msk');
  });

  it('keeps slots contiguous for every subset of optional channels', () => {
    const optional = ['color', 'size', 'opacity', 'mask'] as const;
    const widths = { color: 3, size: 1, opacity: 1, mask: 1 };
    for (let mask = 0; mask < 16; mask++) {
      const extra: Partial<PointsBindings> = {};
      let expected = 3;
      optional.forEach((key, bit) => {
        if (mask & (1 << bit)) {
          extra[key] = attribute(key, widths[key]);
          expected++;
        }
      });
      const slots = slotsOf(pointsShader(bindings(extra)));
      expect(slots, `subset ${mask}`).toEqual([...Array(expected).keys()]);
    }
  });
});

describe('attribute width handling', () => {
  it('reads a vec3 position with per-component indexing', () => {
    const code = pointsShader(bindings());
    expect(code).toContain('b_pos[i * 3u + 0u]');
    expect(code).toContain('b_pos[i * 3u + 2u]');
  });

  it('pads a 2-component position to vec3 rather than reading past the buffer', () => {
    // A 2D graph is legal; reading index 2 of a stride-2 buffer would read the next row's x.
    const code = pointsShader(bindings({ position: attribute('P', 2) }));
    expect(code).toContain('b_pos[i * 2u + 1u]');
    expect(code).not.toContain('b_pos[i * 2u + 2u]');
    expect(code).toMatch(/vec3<f32>\(b_pos\[i \* 2u \+ 0u\], b_pos\[i \* 2u \+ 1u\], 0\.0\)/);
  });

  it('broadcasts a scalar colour attribute to vec3', () => {
    const code = pointsShader(bindings({ color: attribute('Cd', 1) }));
    expect(code).toContain('vec3<f32>(b_col[i])');
  });

  it('reads only the first component of size and opacity', () => {
    const code = pointsShader(bindings({ size: attribute('pscale', 1), opacity: attribute('Alpha', 1) }));
    expect(code).toContain('b_siz[i * 1u + 0u]');
    expect(code).toContain('b_opa[i * 1u + 0u]');
  });

  it('falls back to constants when a channel is missing', () => {
    const code = pointsShader(bindings());
    expect(code).toMatch(/out\.color = vec3<f32>\(/);
    expect(code).toMatch(/clamp\(1\.0 \* style\.y/);
  });
});

describe('guards', () => {
  it('discards NaN positions, which is how Arrow nulls arrive', () => {
    const code = pointsShader(bindings());
    expect(code).toMatch(/p\.x != p\.x/);
    expect(code).toMatch(/p\.z != p\.z/);
  });

  it('culls geometry behind the camera', () => {
    expect(pointsShader(bindings())).toContain('center.w <= 0.0');
  });

  it('emits the mask test only when a mask exists, before the position read', () => {
    const without = pointsShader(bindings());
    expect(without).not.toContain('b_msk');

    const withMask = pointsShader(bindings({ mask: attribute('__mask', 1) }));
    const maskAt = withMask.indexOf('b_msk');
    const posAt = withMask.indexOf('b_pos[');
    expect(maskAt).toBeGreaterThan(0);
    // Reading position first would waste work on a discarded instance.
    expect(maskAt).toBeLessThan(posAt);
  });

  it('pushes rejected instances behind the near plane rather than leaving them undefined', () => {
    const code = pointsShader(bindings({ mask: attribute('__mask', 1) }));
    expect((code.match(/vec4<f32>\(0\.0, 0\.0, -2\.0, 1\.0\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('clamps the radius between the style uniform’s min and max', () => {
    expect(pointsShader(bindings({ size: attribute('pscale', 1) })))
      .toMatch(/clamp\(.*style\.x, style\.z, style\.w\)/);
  });
});

describe('shader structure', () => {
  it('declares both entry points with the names the pipeline uses', () => {
    const code = pointsShader(bindings());
    expect(code).toMatch(/@vertex\s+fn vs\(/);
    expect(code).toMatch(/@fragment\s+fn fs\(/);
  });

  it('needs no vertex buffer: the quad comes from vertex_index', () => {
    const code = pointsShader(bindings());
    expect(code).toContain('@builtin(vertex_index)');
    expect(code).toContain('@builtin(instance_index)');
    expect(code).toMatch(/CORNERS\s*=\s*array<vec2<f32>, 6>/);
  });

  it('declares the View uniform matching the camera pack layout', () => {
    // mat4 (64 bytes) + eye vec4 (16) + viewport vec4 (16) = 96, VIEW_UNIFORM_SIZE.
    const code = pointsShader(bindings());
    expect(code).toMatch(/viewProj:\s*mat4x4<f32>/);
    expect(code).toMatch(/eye:\s*vec4<f32>/);
    expect(code).toMatch(/viewport:\s*vec4<f32>/);
  });

  it('has balanced braces and parentheses for every channel subset', () => {
    const combos: Partial<PointsBindings>[] = [
      {}, { color: attribute('Cd', 3) }, { size: attribute('pscale', 1) },
      { color: attribute('Cd', 3), size: attribute('pscale', 1), mask: attribute('__mask', 1) },
    ];
    for (const extra of combos) {
      const code = pointsShader(bindings(extra));
      expect(balanced(code)).toBe(true);
    }
  });

  it('declares no WGSL reserved word as an identifier', () => {
    const code = pointsShader(bindings({ color: attribute('Cd', 3), mask: attribute('__mask', 1) }));
    for (const word of ['meta', 'type', 'filter', 'from', 'mod', 'where', 'sample', 'shared']) {
      expect(new RegExp(`(?:^|[^.\\w])${word}(?![\\w])\\s*[:=;]`, 'm').test(code), word).toBe(false);
    }
  });

  it('discards fragments outside the unit circle, so points are round', () => {
    const code = pointsShader(bindings());
    expect(code).toMatch(/r2 > 1\.0.*discard/s);
  });
});

describe('uniform sizes', () => {
  it('the style uniform is a single vec4', () => {
    expect(STYLE_UNIFORM_SIZE).toBe(16);
  });

  it('the heatmap weight quantum is documented and coarse', () => {
    // WebGPU has no float atomics, so weights are fixed point. Anything below 1/256
    // contributes nothing, which is a real precision limit worth pinning.
    expect(WEIGHT_FIXED_POINT).toBe(256);
    expect(1 / WEIGHT_FIXED_POINT).toBeCloseTo(0.0039, 4);
  });
});

function balanced(code: string): boolean {
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  const stack: string[] = [];
  for (const ch of code) {
    if ('([{'.includes(ch)) stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) return false;
  }
  return stack.length === 0;
}
