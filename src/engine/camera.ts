/**
 * Orbit camera. Hand-rolled 4x4 math to keep the dependency list at DuckDB + Arrow.
 *
 * The camera is the clearest example of a *value* parameter: dragging the mouse writes
 * 96 bytes into a uniform buffer. No requery, no kernel dispatch, no attribute
 * reallocation. Same mechanism the graph uses for a radius slider.
 */

export interface OrbitState {
  yaw: number;
  pitch: number;
  distance: number;
  target: [number, number, number];
  fovY: number;
  near: number;
  far: number;
}

/** Bytes in the View uniform: mat4 (64) + eye vec4 (16) + viewport vec4 (16). */
export const VIEW_UNIFORM_SIZE = 96;

export class OrbitCamera {
  state: OrbitState = {
    // Framed for the mercator world box, which is roughly 1 x 0.4 world units wide
    // after normalization. Wider defaults leave the data as a speck.
    yaw: 0.45,
    pitch: 0.5,
    distance: 0.95,
    target: [0, 0, 0],
    fovY: (50 * Math.PI) / 180,
    near: 0.01,
    far: 100,
  };

  /** Bumped on every change so the frame loop knows to re-upload. */
  version = 0;

  private readonly scratch = new Float32Array(VIEW_UNIFORM_SIZE / 4);

  eye(): [number, number, number] {
    const { yaw, pitch, distance, target } = this.state;
    const cp = Math.cos(pitch);
    return [
      target[0] + distance * cp * Math.sin(yaw),
      target[1] + distance * Math.sin(pitch),
      target[2] + distance * cp * Math.cos(yaw),
    ];
  }

  /** Pack the View uniform. Reuses one scratch array, so copy it if you retain it. */
  pack(width: number, height: number): Float32Array {
    const eye = this.eye();
    const view = lookAt(eye, this.state.target, [0, 1, 0]);
    const proj = perspective(this.state.fovY, width / Math.max(1, height), this.state.near, this.state.far);
    const vp = multiply(proj, view);
    this.scratch.set(vp, 0);
    this.scratch[16] = eye[0];
    this.scratch[17] = eye[1];
    this.scratch[18] = eye[2];
    this.scratch[19] = 1;
    this.scratch[20] = width;
    this.scratch[21] = height;
    this.scratch[22] = 0;
    this.scratch[23] = 0;
    return this.scratch;
  }

  /**
   * Wire pointer + wheel interaction to an element. Returns a teardown function.
   * Attached to the pane container rather than a canvas so the same camera drives
   * whichever renderer is on screen.
   */
  attach(canvas: HTMLElement): () => void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let panning = false;

    const down = (e: PointerEvent) => {
      dragging = true;
      panning = e.shiftKey || e.button === 1;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (panning) {
        // Pan in the camera's screen plane, scaled so it feels the same at any zoom.
        const [rx, , rz] = right(this.state.yaw);
        const k = this.state.distance * 0.0015;
        this.state.target[0] -= dx * k * rx;
        this.state.target[2] -= dx * k * rz;
        this.state.target[1] += dy * k;
      } else {
        this.state.yaw -= dx * 0.006;
        this.state.pitch = clamp(this.state.pitch + dy * 0.006, -1.5, 1.5);
      }
      this.version++;
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      panning = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.state.distance = clamp(this.state.distance * Math.exp(e.deltaY * 0.0012), 0.02, 60);
      this.version++;
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }
}

// --- 4x4 math, column-major to match WGSL's mat4x4<f32> ---------------------

function right(yaw: number): [number, number, number] {
  return [Math.cos(yaw), 0, -Math.sin(yaw)];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far * nf;
  m[11] = -1;
  m[14] = far * near * nf;
  return m;
}

export function lookAt(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number],
): Float32Array {
  let [zx, zy, zz] = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len === 0) {
    // Looking straight up or down: pick any axis perpendicular to z.
    xx = 1; xy = 0; xz = 0;
  } else {
    xx /= len; xy /= len; xz /= len;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}
