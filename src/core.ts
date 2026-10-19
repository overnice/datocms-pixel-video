// The effect: a source (video, image or canvas) posterised into four
// brightness layers, each drawn as its own pixel mosaic, plus a pointer lens.
// Derived from the Overnice lab prototype (datocms/pixel-video), with the same
// look. <pixel-video> (element.ts) drives it; use this directly only for a
// custom render loop.
//
// Per frame:
//   1. Prepare: draw the source into a small canvas (longest side ≤ 400px,
//      optional blur) and upload it as a texture. Only when there is something
//      new: a new video frame, another source, or a changed setting that
//      affects it. Normally this stays on the GPU. Dithering (Floyd–Steinberg,
//      inherently sequential) is the exception: it reads the pixels back and
//      runs on the CPU, uploading a one-byte-per-pixel layer map instead.
//   2. Draw: a fragment shader sorts each mosaic cell into a layer (background,
//      shadows, midtones, highlights) by brightness and paints the four
//      mosaics, each with its own pixel size, fill, stroke and stroke weight.
//      The lens is drawn on top: a coarser grid whose squares shrink to nothing
//      at an animated, blob-shaped edge. Skipped when nothing changed.

import type { PixelVideoSettings } from './settings';

export type FrameSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

export interface PixelVideoEffect {
  /** What to draw. A new source is prepared on the next render. */
  setSource(el: FrameSource | null): void;
  /**
   * Draw a frame if anything changed since the last one (new video frame,
   * settings, size, pointer) or the lens is animating. `time` in seconds
   * drives the lens edge. Returns whether it drew.
   */
  render(time: number): boolean;
  /** Force the next render to draw. Call after changing the settings. */
  invalidate(): void;
  /** The lens is showing (pointer over the canvas, `hover` on): keep rendering. */
  readonly hovering: boolean;
  destroy(): void;
}

export interface MountOptions {
  /** Called when something outside a render (resize, pointer, a restored
   *  WebGL context) needs a new frame: schedule a render. */
  onInvalidate?: () => void;
}

const MAX_SIDE = 400;

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

/** Pixels at or below this alpha (0–255) are never drawn. */
const MIN_ALPHA = 128;
/** Layer-map value for those pixels. */
const SKIP = 255;

// ── stage 1: CPU dithering (only with `dither` on) ───────────────────────────

/** Brightness per pixel, Floyd–Steinberg dithered to pure 0 / 255. Skipped
 *  pixels don't take part (their error isn't spread). */
function ditherBrightness(px: Uint8ClampedArray, w: number, h: number, lum: Float32Array) {
  for (let i = 0; i < w * h; i++) lum[i] = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (px[i * 4 + 3] <= MIN_ALPHA) continue;
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
}

/** Dithered layer map (0–3 per pixel, SKIP for transparent) of the prepared
 *  frame. Buffers are reused between frames. */
function createDitherer() {
  let layers = new Uint8Array(0);
  let lum = new Float32Array(0);
  return (px: Uint8ClampedArray, w: number, h: number, v: PixelVideoSettings) => {
    if (layers.length !== w * h) {
      layers = new Uint8Array(w * h);
      lum = new Float32Array(w * h);
    }
    ditherBrightness(px, w, h, lum);
    for (let i = 0; i < w * h; i++) {
      const b = lum[i];
      layers[i] =
        px[i * 4 + 3] <= MIN_ALPHA
          ? SKIP
          : b < v.tShadow
            ? 0
            : b < v.tMid
              ? 1
              : b < v.tHigh
                ? 2
                : 3;
    }
    return layers;
  };
}

// ── stage 2: GPU ─────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uRes;            // canvas, device px
uniform sampler2D uFrame;     // the prepared frame (RGBA), or a layer map (R8)
uniform bool uLayerMap;       // uFrame is a layer map: layer * (1/255), 255 = skip
uniform ivec2 uFrameSize;
uniform vec3 uThresholds;     // tShadow, tMid, tHigh (brightness 0–255)
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

// Layer of the grid cell whose top-left corner is at local position o
// (nearest-neighbour in the prepared frame), or -1 if nothing is drawn there.
int bucketAt(vec2 o) {
  if (o.x < 0.0 || o.y < 0.0 || o.x >= uDraw.x || o.y >= uDraw.y) return -1;
  ivec2 t = min(ivec2(floor(o * vec2(uFrameSize) / uDraw)), uFrameSize - 1);
  vec4 c = texelFetch(uFrame, t, 0);
  if (uLayerMap) {
    int b = int(c.r * 255.0 + 0.5);
    return b > 3 ? -1 : b;
  }
  // The same 8-bit maths as the CPU path, so both look identical.
  ivec4 px = ivec4(c * 255.0 + 0.5);
  if (px.a <= ${MIN_ALPHA}) return -1;
  float b = 0.2126 * float(px.r) + 0.7152 * float(px.g) + 0.0722 * float(px.b);
  return b < uThresholds.x ? 0 : b < uThresholds.y ? 1 : b < uThresholds.z ? 2 : 3;
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

const LAYERS = ['bg', 'shadow', 'mid', 'high'] as const;

const rgbCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let out = rgbCache.get(hex);
  if (!out) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
    const n = parseInt(full, 16);
    out = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    rgbCache.set(hex, out);
  }
  return out;
}

export function mountPixelVideo(
  canvas: HTMLCanvasElement,
  settings: PixelVideoSettings,
  { onInvalidate }: MountOptions = {},
): PixelVideoEffect {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
  if (!gl) throw new Error('WebGL2 unavailable');

  // ── GL resources (re-created if the context is lost and restored) ────────
  let program: WebGLProgram;
  let texture: WebGLTexture;
  const locations = new Map<string, WebGLUniformLocation | null>();
  const u = (name: string) => {
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
    return locations.get(name)!;
  };

  const setup = () => {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? '');
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? '');
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.useProgram(program);
    locations.clear();

    // One triangle covering the viewport.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(u('uFrame'), 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.viewport(0, 0, canvas.width, canvas.height);
    texShape = '';
    prepared = '';
    preparedFor = -1;
  };

  // ── stage 1: prepare the frame ───────────────────────────────────────────
  // Two scratch canvases: reading pixels back (dither) needs a CPU-backed one
  // (willReadFrequently), which would slow down the GPU path if shared.
  const scratch = (readBack: boolean) => {
    const c = document.createElement('canvas');
    return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: readBack })! };
  };
  let gpuScratch: ReturnType<typeof scratch> | null = null;
  let cpuScratch: ReturnType<typeof scratch> | null = null;
  const dither = createDitherer();

  let source: FrameSource | null = null;
  let sourceId = 0;
  let canvasReads = 0;
  let prepared = ''; // what the texture holds; '' = nothing
  let texShape = ''; // format + size of the allocated texture
  let frameW = 0; // prepared frame, px
  let frameH = 0;
  let preparedFor = -1; // sourceId the texture holds a frame of
  let sourceW = 0; // that source's own size
  let sourceH = 0;

  /** Upload the source's current frame unless the texture already holds it. */
  const prepare = (el: FrameSource, v: PixelVideoSettings): boolean => {
    if (!ready(el)) return false;
    const [sw, sh] = sizeOf(el);
    if (!sw || !sh) return false;
    // A video frame is identified by its playback position, an image by its
    // URL. A canvas can change without telling, so it is always re-read.
    const frame =
      el instanceof HTMLVideoElement
        ? el.currentTime
        : el instanceof HTMLImageElement
          ? el.currentSrc
          : ++canvasReads;
    const key = `${sourceId}|${frame}|${sw}x${sh}|${v.smoothing}|${v.dither && `${v.tShadow},${v.tMid},${v.tHigh}`}`;
    if (key === prepared) return false;

    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const s = v.dither ? (cpuScratch ??= scratch(true)) : (gpuScratch ??= scratch(false));
    if (s.canvas.width !== w || s.canvas.height !== h) {
      s.canvas.width = w;
      s.canvas.height = h;
    } else {
      s.ctx.clearRect(0, 0, w, h);
    }
    // `ctx.filter` is unsupported in Safari: smoothing is a no-op there.
    s.ctx.filter = v.smoothing > 0 ? `blur(${v.smoothing}px)` : 'none';
    s.ctx.drawImage(el, 0, 0, w, h);
    s.ctx.filter = 'none';

    const shape = `${v.dither ? 'R8' : 'RGBA8'} ${w}x${h}`;
    const fresh = shape !== texShape;
    if (v.dither) {
      const layers = dither(s.ctx.getImageData(0, 0, w, h).data, w, h, v);
      if (fresh) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, layers);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, layers);
    } else if (fresh) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, s.canvas);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, s.canvas);
    }
    texShape = shape;
    prepared = key;
    frameW = w;
    frameH = h;
    preparedFor = sourceId;
    sourceW = sw;
    sourceH = sh;
    return true;
  };

  // ── size, pointer, context loss ──────────────────────────────────────────
  let dpr = 1;
  let dirty = true;
  let lost = false;
  const invalidate = () => {
    dirty = true;
    onInvalidate?.();
  };

  const resize = () => {
    dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; // clears the canvas
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    invalidate();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  // Browser zoom / moving to another screen changes the pixel ratio but not
  // the CSS size, so ResizeObserver alone misses it.
  let dprQuery: MediaQueryList | null = null;
  const watchDpr = () => {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
  };
  const onDprChange = () => {
    resize();
    watchDpr();
  };
  watchDpr();

  // Pointer, in device px relative to the canvas; null when outside.
  let pointer: [number, number] | null = null;
  const track = (e: PointerEvent) => {
    pointer = [e.offsetX * dpr, e.offsetY * dpr];
    if (settings.hover) invalidate();
  };
  const leave = () => {
    pointer = null;
    if (settings.hover) invalidate();
  };
  const pointerEvents = {
    pointermove: track,
    pointerenter: track,
    pointerdown: track,
    pointerleave: leave,
    pointercancel: leave,
  };
  for (const [type, fn] of Object.entries(pointerEvents))
    canvas.addEventListener(type, fn as EventListener);

  const onLost = (e: Event) => {
    e.preventDefault(); // allow the browser to restore it
    lost = true;
  };
  const onRestored = () => {
    lost = false;
    setup();
    invalidate();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  setup();
  resize();

  // Per-layer uniform arrays, reused every draw.
  const size = new Float32Array(4);
  const fill = new Float32Array(12);
  const stroke = new Float32Array(12);
  const weight = new Float32Array(4);

  return {
    setSource(el) {
      if (el === source) return;
      source = el;
      sourceId++;
      dirty = true;
    },

    get hovering() {
      return settings.hover && pointer !== null;
    },

    invalidate() {
      dirty = true;
    },

    render(time) {
      if (lost) return false;
      const v = settings;
      const fresh = source ? prepare(source, v) : false;
      const lens = v.hover && pointer !== null;
      if (!fresh && !dirty && !lens) return false;
      dirty = false;

      const W = canvas.width;
      const H = canvas.height;
      gl.uniform2f(u('uRes'), W, H);

      // A new source that isn't ready yet draws as empty, not as the old one.
      const hasFrame = !!source && preparedFor === sourceId;
      gl.uniform1i(u('uHasFrame'), hasFrame ? 1 : 0);
      if (hasFrame) {
        gl.uniform1i(u('uLayerMap'), v.dither ? 1 : 0);
        gl.uniform2i(u('uFrameSize'), frameW, frameH);
        gl.uniform3f(u('uThresholds'), v.tShadow, v.tMid, v.tHigh);

        // Contain-fit the source, offsets floored to avoid subpixel seams.
        const s = Math.min(W / sourceW, H / sourceH);
        const drawW = sourceW * s;
        const drawH = sourceH * s;
        const offX = Math.floor((W - drawW) / 2);
        const offY = Math.floor((H - drawH) / 2);
        gl.uniform2f(u('uOffset'), offX, offY);
        gl.uniform2f(u('uDraw'), drawW, drawH);

        gl.uniform1i(u('uHover'), lens ? 1 : 0);
        if (lens) gl.uniform2f(u('uPointer'), pointer![0] - offX, pointer![1] - offY);
      }

      for (let i = 0; i < 4; i++) {
        const l = LAYERS[i];
        size[i] = Math.max(1, v[`${l}Size`] * dpr);
        fill.set(rgb(v[`${l}Fill`]), i * 3);
        stroke.set(rgb(v[`${l}Stroke`]), i * 3);
        weight[i] = v[`${l}StrokeWeight`] * dpr;
      }
      gl.uniform1fv(u('uSize'), size);
      gl.uniform3fv(u('uFill'), fill);
      gl.uniform3fv(u('uStroke'), stroke);
      gl.uniform1fv(u('uWeight'), weight);

      gl.uniform1f(u('uTime'), time * v.hoverSpeed);
      gl.uniform1f(u('uRadius'), v.hoverRadius * dpr);
      gl.uniform1f(u('uDistort'), v.hoverDistortion * dpr);
      gl.uniform1f(u('uFalloff'), v.hoverFalloff * dpr);
      gl.uniform1f(u('uHoverSize'), Math.max(1, v.hoverPixelSize * dpr));

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },

    destroy() {
      observer.disconnect();
      dprQuery?.removeEventListener('change', onDprChange);
      for (const [type, fn] of Object.entries(pointerEvents))
        canvas.removeEventListener(type, fn as EventListener);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      source = null;
    },
  };
}
