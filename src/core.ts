// The effect itself, lifted from the Overnice lab prototype (datocms/pixel-video)
// unchanged apart from the settings type. Feed it settings and a source, then
// call render(time) once per frame. <pixel-video> (element.ts) does all of
// that for you; use this directly only for a custom render loop.
//
// Each frame runs in two stages:
//   1. CPU: draw the source into an offscreen canvas (longest side ≤ 400px,
//      optional blur), read it back, optionally Floyd–Steinberg dither it, then
//      sort every pixel into one of four brightness layers (or "skip" for
//      transparent pixels). The result is a one-byte-per-pixel bucket map.
//   2. GPU: a fragment shader draws the four layers (background, shadows,
//      midtones, highlights) as mosaics with their own pixel size, fill,
//      stroke and stroke weight. The pointer "lens" is drawn on top: a coarser
//      grid whose squares shrink to nothing at an animated, blob-shaped edge.
//      Doing this per pixel on the GPU replaces thousands of fillRect calls.

import type { PixelVideoSettings } from './settings';

export type FrameSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

const MAX_SIDE = 400;
/** Bucket value for pixels that are never drawn (alpha ≤ 128). */
const SKIP = 255;

function sizeOf(el: FrameSource): [number, number] {
  if (el instanceof HTMLVideoElement) return [el.videoWidth, el.videoHeight];
  if (el instanceof HTMLImageElement) return [el.naturalWidth, el.naturalHeight];
  return [el.width, el.height];
}

function ready(el: FrameSource) {
  if (el instanceof HTMLVideoElement) return el.readyState >= 2;
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0;
  return el.width > 0;
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ── stage 1: CPU pre-processing ──────────────────────────────────────────────

export interface Buckets {
  width: number;
  height: number;
  /** One byte per pixel: 0 background, 1 shadows, 2 midtones, 3 highlights,
   *  255 skip. */
  data: Uint8Array;
}

/** Brightness per pixel, Floyd–Steinberg dithered to pure 0 / 255 on the way.
 *  Pixels with alpha < 128 are left out (their error isn't spread). */
function ditheredBrightness(px: Uint8ClampedArray, w: number, h: number): Float32Array {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (px[i * 4 + 3] < 128) continue;
      const old = lum[i];
      const next = old < 128 ? 0 : 255;
      const err = old - next;
      lum[i] = next;
      if (x + 1 < w) lum[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) lum[i + w - 1] += (err * 3) / 16;
        lum[i + w] += (err * 5) / 16;
        if (x + 1 < w) lum[i + w + 1] += err / 16;
      }
    }
  }
  return lum;
}

export function createProcessor() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let data = new Uint8Array(0);

  return (source: FrameSource, v: PixelVideoSettings): Buckets | null => {
    if (!ready(source)) return null;
    const [sw, sh] = sizeOf(source);
    if (!sw || !sh) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    // `ctx.filter` is unsupported in Safari: smoothing is a no-op there.
    ctx.filter = v.smoothing > 0 ? `blur(${v.smoothing}px)` : 'none';
    ctx.drawImage(source, 0, 0, w, h);
    ctx.filter = 'none';
    const px = ctx.getImageData(0, 0, w, h).data;

    if (data.length !== w * h) data = new Uint8Array(w * h);
    const lum = v.dither ? ditheredBrightness(px, w, h) : null;
    for (let i = 0; i < w * h; i++) {
      if (px[i * 4 + 3] <= 128) {
        data[i] = SKIP;
        continue;
      }
      const b = lum ? lum[i] : luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      data[i] = b < v.tShadow ? 0 : b < v.tMid ? 1 : b < v.tHigh ? 2 : 3;
    }
    return { width: w, height: h, data };
  };
}

// ── stage 2: GPU rendering ───────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uRes;            // canvas, device px
uniform sampler2D uBuckets;   // R8: bucket * (1/255)
uniform ivec2 uBucketSize;
uniform bool uHasFrame;
uniform vec2 uOffset;         // contain-fit rect of the source, device px
uniform vec2 uDraw;

uniform float uSize[4];       // per layer, device px
uniform vec3 uFill[4];
uniform vec3 uStroke[4];
uniform float uWeight[4];

uniform bool uHover;
uniform vec2 uPointer;        // relative to the draw rect, device px
uniform float uTime;
uniform float uRadius, uDistort, uFalloff, uHoverSize;

out vec4 color;

// Bucket of the grid cell whose top-left corner is at local position o
// (nearest-neighbour in the processed frame), or -1 outside the draw area.
int bucketAt(vec2 o) {
  if (o.x < 0.0 || o.y < 0.0 || o.x >= uDraw.x || o.y >= uDraw.y) return -1;
  ivec2 t = min(ivec2(floor(o * vec2(uBucketSize) / uDraw)), uBucketSize - 1);
  int b = int(texelFetch(uBuckets, t, 0).r * 255.0 + 0.5);
  return b > 3 ? -1 : b;
}

void main() {
  // Top-left origin, like a 2D canvas.
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec3 col = uFill[0]; // whole canvas in the background colour first: no bleed-through

  if (!uHasFrame) { color = vec4(col, 1.0); return; }
  vec2 local = p - uOffset;

  // Base mosaics, in fixed order — later layers paint over earlier ones.
  // A stroke straddles the square's edge like a canvas strokeRect: half inside
  // the square, half spilling into the neighbouring cell.
  for (int L = 0; L < 4; L++) {
    float ps = uSize[L];
    vec2 cell = floor(local / ps);
    vec2 f = local - cell * ps;
    float hw = uWeight[L] * 0.5;
    bool edge = hw > 0.0 && (min(f.x, f.y) < hw || max(f.x, f.y) >= ps - hw);
    if (bucketAt(cell * ps) == L) {
      col = edge ? uStroke[L] : uFill[L];
    } else if (edge) {
      vec2 d = vec2(f.x < hw ? -1.0 : f.x >= ps - hw ? 1.0 : 0.0,
                    f.y < hw ? -1.0 : f.y >= ps - hw ? 1.0 : 0.0);
      if ((d.x != 0.0 && bucketAt((cell + vec2(d.x, 0.0)) * ps) == L) ||
          (d.y != 0.0 && bucketAt((cell + vec2(0.0, d.y)) * ps) == L) ||
          (d.x != 0.0 && d.y != 0.0 && bucketAt((cell + d) * ps) == L)) {
        col = uStroke[L];
      }
    }
  }

  // Hover lens: a coarser grid near the pointer. Each square is scaled by how
  // far its cell centre is inside a wobbling, blob-shaped radius.
  if (uHover) {
    float hs = uHoverSize;
    vec2 cell = floor(local / hs);
    vec2 center = (cell + 0.5) * hs;
    vec2 d = center - uPointer;
    float dist = length(d);
    if (dist < uRadius + abs(uDistort) + hs) {
      float a = atan(d.y, d.x);
      float wobble = 0.5 * sin(a * 3.0 + uTime * 1.3)
                   + 0.3 * cos(a * 5.0 - uTime * 1.9 + 1.7)
                   + 0.2 * sin(a * 8.0 + uTime * 2.7 + 4.1);
      float r = uRadius + uDistort * wobble;
      float s = uFalloff > 0.0 ? clamp((r - dist) / uFalloff, 0.0, 1.0) : step(dist, r);
      int b = s > 0.0 ? bucketAt(cell * hs) : -1;
      if (b >= 0) {
        float half_ = hs * s * 0.5;
        float hw = uWeight[b] * 0.5;
        vec2 q = abs(local - center);
        float m = max(q.x, q.y);
        if (m < half_ + hw) col = (hw > 0.0 && m >= half_ - hw) ? uStroke[b] : uFill[b];
      }
    }
  }

  color = vec4(col, 1.0);
}`;

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function mountPixelVideo(canvas: HTMLCanvasElement, values: PixelVideoSettings) {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 unavailable');

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '');
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? '');
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const locations = new Map<string, WebGLUniformLocation | null>();
  const u = (name: string) => {
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
    return locations.get(name)!;
  };

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(u('uBuckets'), 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const process = createProcessor();
  let source: FrameSource | null = null;
  let dpr = 1;

  const resize = () => {
    dpr = Math.min(devicePixelRatio, 2);
    // Even sizes: H.264 can't encode odd frame dimensions (screen recorders).
    canvas.width = Math.max(2, 2 * Math.round((canvas.clientWidth * dpr) / 2));
    canvas.height = Math.max(2, 2 * Math.round((canvas.clientHeight * dpr) / 2));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  // Pointer, in device px relative to the canvas; null when outside.
  let pointer: [number, number] | null = null;
  const track = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
  };
  const leave = () => (pointer = null);
  canvas.addEventListener('pointermove', track);
  canvas.addEventListener('pointerenter', track);
  canvas.addEventListener('pointerdown', track);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('pointercancel', leave);

  const layers = ['bg', 'shadow', 'mid', 'high'] as const;

  return {
    setSource(el: FrameSource | null) {
      source = el;
    },
    /** `time` in seconds (drives the lens edge animation). */
    render(time: number) {
      const v = values;
      const W = canvas.width;
      const H = canvas.height;
      gl.uniform2f(u('uRes'), W, H);

      const frame = source ? process(source, v) : null;
      gl.uniform1i(u('uHasFrame'), frame ? 1 : 0);
      if (frame && source) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.R8,
          frame.width,
          frame.height,
          0,
          gl.RED,
          gl.UNSIGNED_BYTE,
          frame.data,
        );
        gl.uniform2i(u('uBucketSize'), frame.width, frame.height);

        // Contain-fit the source, offsets floored to avoid subpixel seams.
        const [sw, sh] = sizeOf(source);
        const s = Math.min(W / sw, H / sh);
        const drawW = sw * s;
        const drawH = sh * s;
        const offX = Math.floor((W - drawW) / 2);
        const offY = Math.floor((H - drawH) / 2);
        gl.uniform2f(u('uOffset'), offX, offY);
        gl.uniform2f(u('uDraw'), drawW, drawH);

        const on = v.hover && pointer !== null;
        gl.uniform1i(u('uHover'), on ? 1 : 0);
        if (on) gl.uniform2f(u('uPointer'), pointer![0] - offX, pointer![1] - offY);
      }

      gl.uniform1fv(
        u('uSize'),
        layers.map((l) => Math.max(1, v[`${l}Size`] * dpr)),
      );
      gl.uniform3fv(
        u('uFill'),
        layers.flatMap((l) => rgb(v[`${l}Fill`])),
      );
      gl.uniform3fv(
        u('uStroke'),
        layers.flatMap((l) => rgb(v[`${l}Stroke`])),
      );
      gl.uniform1fv(
        u('uWeight'),
        layers.map((l) => v[`${l}StrokeWeight`] * dpr),
      );

      gl.uniform1f(u('uTime'), time * v.hoverSpeed);
      gl.uniform1f(u('uRadius'), v.hoverRadius * dpr);
      gl.uniform1f(u('uDistort'), v.hoverDistortion * dpr);
      gl.uniform1f(u('uFalloff'), v.hoverFalloff * dpr);
      gl.uniform1f(u('uHoverSize'), Math.max(1, v.hoverPixelSize * dpr));

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      observer.disconnect();
      canvas.removeEventListener('pointermove', track);
      canvas.removeEventListener('pointerenter', track);
      canvas.removeEventListener('pointerdown', track);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointercancel', leave);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
