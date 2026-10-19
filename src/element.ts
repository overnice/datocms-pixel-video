// <pixel-video>: the effect as a drop-in custom element. It owns the hidden
// source <video>/<img>, the render loop and sizing to the source's aspect
// ratio. It loads its source only once near the viewport, plays and draws only
// while on screen (and only when something changed), honours
// prefers-reduced-motion, and falls back to the plain video/image if WebGL2 is
// missing or the source can't be read (CORS).
//
//   <pixel-video src="/hero.mp4" poster="/hero.jpg"></pixel-video>
//
// Attributes: src, type ("video" | "image"; otherwise guessed from the URL),
// poster, settings (JSON), paused, playback-rate, crossorigin.
// Colours in `settings` may be CSS variables (`var(--token, #hex)`): they're
// read from the page's CSS where the element sits, so the site's tokens win.
// Properties: the same, plus `src` may be an array (first playable wins) and
// `settings` takes an object. Several sources can also be given as light-DOM
// <source> children, like a <video>.

import { mountPixelVideo, type PixelVideoEffect } from './core';
import { resolveSettings, type PixelVideoSettings } from './settings';

const COLOR_KEYS = (['bg', 'mid', 'high'] as const).flatMap(
  (l) => [`${l}Fill`, `${l}Stroke`] as const,
);
const VAR = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+?)\s*)?\)$/i;

// Any CSS colour → opaque #rrggbb as it looks on white, by painting it into
// one white pixel: handles every format a site's variables might use (hex,
// rgb(), hsl(), oklch(), …), and flattens see-through colours (palette steps
// 1–4) so layers never stack into new colours.
let swatch: CanvasRenderingContext2D | null | undefined;
function toHex(css: string): string | null {
  swatch ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext(
    '2d',
    { willReadFrequently: true },
  );
  if (!swatch) return null;
  // An invalid colour leaves fillStyle unchanged: try from two seeds.
  swatch.fillStyle = '#000';
  swatch.fillStyle = css;
  const a = swatch.fillStyle;
  swatch.fillStyle = '#fff';
  swatch.fillStyle = css;
  if (swatch.fillStyle !== a) return null;
  const color = swatch.fillStyle;
  swatch.fillStyle = '#fff';
  swatch.fillRect(0, 0, 1, 1);
  swatch.fillStyle = color;
  swatch.fillRect(0, 0, 1, 1);
  const px = swatch.getImageData(0, 0, 1, 1).data;
  return `#${[...px.subarray(0, 3)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

type Media = HTMLVideoElement | HTMLImageElement;

export const TAG = 'pixel-video';

const IMAGE_URL = /\.(avif|bmp|gif|jpe?g|png|svg|webp)([?#]|$)/i;
const VIDEO_TYPES: Record<string, string> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};
const videoType = (url: string) =>
  VIDEO_TYPES[/\.(\w+)(?:[?#]|$)/.exec(url)?.[1].toLowerCase() ?? ''];

/** Is this source list an image (rather than a video)? */
export function isImageSource(srcs: string[], type?: string | null) {
  if (type === 'image') return true;
  if (type === 'video') return false;
  return srcs.length === 1 && IMAGE_URL.test(srcs[0]);
}

// Kept in the shadow root (some browsers won't decode detached or
// display:none videos) but invisible; shown full-size only as the fallback.
const HIDDEN_MEDIA =
  'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
const FALLBACK_MEDIA = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';

const STYLE = `
:host {
  display: block;
  position: relative;
  overflow: hidden;
  aspect-ratio: var(--pixel-video-aspect, 16 / 9);
}
:host([hidden]) { display: none; }
canvas { display: block; width: 100%; height: 100%; }
`;

// One stylesheet shared by every instance (where constructable stylesheets
// are supported), instead of a <style> parsed per element.
let sheet: CSSStyleSheet | null | undefined;
function adoptStyles(root: ShadowRoot) {
  if (sheet === undefined) {
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
    } catch {
      sheet = null;
    }
  }
  if (sheet) root.adoptedStyleSheets = [sheet];
  else root.innerHTML = `<style>${STYLE}</style>`;
}

// Two observers shared by every instance: "near" (within a screen of the
// viewport) starts loading the source; "visible" plays and draws it.
type Watcher = (entry: IntersectionObserverEntry) => void;
const watchers = new WeakMap<Element, { near: Watcher; visible: Watcher }>();
let observers: { near: IntersectionObserver; visible: IntersectionObserver } | null = null;
function observe(el: Element, near: Watcher, visible: Watcher) {
  observers ??= {
    near: new IntersectionObserver(
      (entries) => entries.forEach((e) => watchers.get(e.target)?.near(e)),
      { rootMargin: '100% 0px' },
    ),
    visible: new IntersectionObserver((entries) =>
      entries.forEach((e) => watchers.get(e.target)?.visible(e)),
    ),
  };
  watchers.set(el, { near, visible });
  observers.near.observe(el);
  observers.visible.observe(el);
}
function unobserve(el: Element) {
  watchers.delete(el);
  observers?.near.unobserve(el);
  observers?.visible.unobserve(el);
}

// SSR-safe: importing this module on the server must not touch the DOM.
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;

export class PixelVideoElement extends Base {
  static observedAttributes = [
    'src',
    'type',
    'poster',
    'settings',
    'paused',
    'playback-rate',
    'crossorigin',
  ];

  /** The resolved settings (defaults ← `settings`). Set `settings` to change
   *  them. */
  readonly values: PixelVideoSettings = resolveSettings();
  /** `values` with every colour resolved to hex: what the effect draws. */
  #draw: PixelVideoSettings = { ...this.values };

  #src: string | string[] | null = null;
  #settings: Partial<PixelVideoSettings> | null = null;
  #canvas!: HTMLCanvasElement;
  #effect: PixelVideoEffect | null = null;
  #media: Media | null = null;
  #poster: HTMLImageElement | null = null;
  #failed = false;
  #lastError: { message: string; cause?: unknown } | null = null;
  #raf = 0;
  #near = false;
  #onScreen = false;
  #loadQueued = false;
  #reducedMotion: MediaQueryList | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    this.#canvas = document.createElement('canvas');
    this.#canvas.part.add('canvas');
    // Decorative by default. For meaningful content, label the element itself
    // (role="img" aria-label="…").
    this.#canvas.setAttribute('aria-hidden', 'true');
    root.append(this.#canvas);
  }

  // ── properties ────────────────────────────────────────────────────────────

  /** A URL, or several (first playable wins). Overrides the attribute. */
  get src(): string | string[] | null {
    return this.#src ?? this.getAttribute('src');
  }
  set src(value: string | string[] | null) {
    const same = JSON.stringify(value) === JSON.stringify(this.#src);
    this.#src = value;
    if (!same) this.#queueLoad();
  }

  /** Partial settings (e.g. the lab's "Copy values (JSON)"). Overrides the
   *  attribute. */
  get settings(): Partial<PixelVideoSettings> | null {
    return this.#settings;
  }
  set settings(value: Partial<PixelVideoSettings> | null) {
    this.#settings = value;
    this.#applySettings();
  }

  get paused() {
    return this.hasAttribute('paused');
  }
  set paused(value: boolean) {
    this.toggleAttribute('paused', value);
  }

  get playbackRate() {
    const rate = Number(this.getAttribute('playback-rate') ?? 1);
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
  }
  set playbackRate(value: number) {
    this.setAttribute('playback-rate', String(value));
  }

  /** The last problem reported (also sent as a `pixel-video-error` event). */
  get error() {
    return this.#lastError;
  }

  /** Re-read `var()` colours from the page's CSS, e.g. after the site
   *  switches theme. (Done automatically when attached and on new settings.) */
  refreshColors() {
    for (const key of COLOR_KEYS) {
      const value = this.values[key];
      const m = VAR.exec(value);
      let hex: string | null = null;
      if (m) {
        const token = this.isConnected ? getComputedStyle(this).getPropertyValue(m[1]).trim() : '';
        hex = (token && toHex(token)) || (m[2] ? toHex(m[2]) : null);
      } else {
        hex = toHex(value);
      }
      this.#draw[key] = hex ?? 'transparent';
    }
    this.#effect?.invalidate();
    this.#requestFrame();
  }

  /** The hidden source element (a <video> or <img>), once loaded. */
  get media(): Media | null {
    return this.#media;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback() {
    // Properties set before the element was defined (e.g. by a framework)
    // shadow the accessors; re-run them through the setters.
    for (const key of ['src', 'settings', 'paused', 'playbackRate'] as const) {
      if (Object.prototype.hasOwnProperty.call(this, key)) {
        const value = (this as Record<string, unknown>)[key];
        delete (this as Record<string, unknown>)[key];
        (this as Record<string, unknown>)[key] = value;
      }
    }

    this.#applySettings();
    try {
      this.#effect = mountPixelVideo(this.#canvas, this.#draw, {
        onInvalidate: this.#requestFrame,
        preserveDrawingBuffer: this.hasAttribute('preserve-drawing-buffer'),
      });
    } catch (error) {
      this.#fail(error);
    }

    this.#reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.#reducedMotion.addEventListener('change', this.#update);
    document.addEventListener('visibilitychange', this.#update);
    observe(
      this,
      (entry) => {
        // Load once it comes near; keep what's loaded when it moves away.
        if (!entry.isIntersecting || this.#near) return;
        this.#near = true;
        this.#queueLoad();
      },
      (entry) => {
        this.#onScreen = entry.isIntersecting;
        this.#update();
      },
    );
  }

  disconnectedCallback() {
    unobserve(this);
    this.#reducedMotion?.removeEventListener('change', this.#update);
    document.removeEventListener('visibilitychange', this.#update);
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#near = false;
    this.#onScreen = false;
    this.#effect?.destroy();
    this.#effect = null;
    this.#dropMedia();
    this.#failed = false;
    this.#lastError = null;
    this.#canvas.hidden = false;
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null) {
    if (old === value || !this.isConnected) return;
    switch (name) {
      case 'settings':
        this.#applySettings();
        break;
      case 'paused':
      case 'playback-rate':
        this.#update();
        break;
      default: // src, type, poster, crossorigin
        if (name !== 'src' || this.#src === null) this.#queueLoad();
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #applySettings() {
    let settings = this.#settings;
    const json = this.getAttribute('settings');
    if (!settings && json) {
      try {
        settings = JSON.parse(json);
      } catch {
        console.warn('[pixel-video] the settings attribute is not valid JSON');
      }
    }
    Object.assign(this.values, resolveSettings(settings));
    Object.assign(this.#draw, this.values);
    this.refreshColors();
  }

  #sources(): { src: string; type?: string }[] {
    const src = this.src;
    if (Array.isArray(src)) return src.filter(Boolean).map((s) => ({ src: s }));
    if (src) return [{ src }];
    return [...this.querySelectorAll(':scope > source')].flatMap((el) => {
      const s = el.getAttribute('src');
      return s ? [{ src: s, type: el.getAttribute('type') ?? undefined }] : [];
    });
  }

  #dropMedia() {
    for (const el of [this.#media, this.#poster]) {
      if (!el) continue;
      if (el instanceof HTMLVideoElement) {
        el.pause();
        el.replaceChildren();
        el.removeAttribute('src');
        el.load(); // releases the decoder and network connection
      }
      el.remove();
    }
    this.#media = this.#poster = null;
  }

  /** Several changes in one task (e.g. a framework setting src, type and
   *  poster one after another) reload the source once. */
  #queueLoad() {
    if (this.#loadQueued) return;
    this.#loadQueued = true;
    queueMicrotask(() => {
      this.#loadQueued = false;
      this.#load();
    });
  }

  #load() {
    if (!this.isConnected || !this.#near) return;
    this.#dropMedia();
    const sources = this.#sources();
    const crossOrigin = this.getAttribute('crossorigin') ?? 'anonymous';
    const root = this.shadowRoot!;

    const poster = this.getAttribute('poster');
    if (poster) {
      const img = Object.assign(new Image(), { crossOrigin, src: poster });
      img.addEventListener('load', () => this.#fit(img), { once: true });
      this.#poster = img;
    }

    if (!sources.length) {
      this.#update();
      return;
    }

    let media: Media;
    if (
      isImageSource(
        sources.map((s) => s.src),
        this.getAttribute('type'),
      )
    ) {
      media = Object.assign(new Image(), { crossOrigin, alt: '', src: sources[0].src });
      media.addEventListener('load', () => this.#fit(media));
      media.addEventListener('error', () => this.#error(`couldn't load ${sources[0].src}`));
    } else {
      const video = Object.assign(document.createElement('video'), {
        crossOrigin,
        muted: true,
        defaultMuted: true,
        loop: true,
        playsInline: true,
        preload: 'auto',
      });
      video.setAttribute('muted', ''); // iOS checks the attribute for autoplay
      video.setAttribute('playsinline', '');
      // It's a texture, not a player: no picture-in-picture or cast buttons.
      video.setAttribute('disablepictureinpicture', '');
      video.setAttribute('disableremoteplayback', '');
      for (const s of sources) {
        const el = Object.assign(document.createElement('source'), { src: s.src });
        const type = s.type ?? videoType(s.src);
        if (type) el.type = type;
        video.append(el);
      }
      // A failed <source> fires on the <source>; only the last one is fatal.
      video.lastElementChild!.addEventListener('error', () =>
        this.#error(`couldn't play any of: ${sources.map((s) => s.src).join(', ')}`),
      );
      video.addEventListener('loadedmetadata', () => this.#fit(video));
      // The loop idles when nothing changes; these bring in new frames.
      for (const type of ['loadeddata', 'play', 'seeked'])
        video.addEventListener(type, this.#requestFrame);
      media = video;
    }
    media.setAttribute('aria-hidden', 'true');
    media.style.cssText = this.#failed ? FALLBACK_MEDIA : HIDDEN_MEDIA;
    root.append(media);
    this.#media = media;
    this.#update();
  }

  /** Size the host to the source's aspect ratio (unless the page sets one). */
  #fit(el: Media) {
    const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    // The poster only sizes the box until the real source knows its size.
    if (el === this.#poster && this.#media && this.#mediaReady()) return;
    if (w && h) this.style.setProperty('--pixel-video-aspect', `${w} / ${h}`);
    if (el !== this.#poster) this.dispatchEvent(new Event('load'));
    this.#requestFrame();
  }

  #mediaReady() {
    const m = this.#media;
    if (!m) return false;
    return m instanceof HTMLVideoElement ? m.readyState >= 2 : m.complete && m.naturalWidth > 0;
  }

  /** The frame to draw: the source, or the poster while the source loads. */
  #frameSource() {
    if (this.#mediaReady() || !this.#poster) return this.#media;
    return this.#poster.complete && this.#poster.naturalWidth ? this.#poster : this.#media;
  }

  get #visible() {
    return this.isConnected && this.#onScreen && !document.hidden;
  }

  /** The effect can draw (in the fallback the plain source shows instead). */
  get #live() {
    return this.#visible && !this.#failed && !!this.#effect;
  }

  /** Draw on the next animation frame (if on screen). Idempotent. */
  #requestFrame = () => {
    if (!this.#raf && this.#live) this.#raf = requestAnimationFrame(this.#tick);
  };

  #tick = (now: number) => {
    this.#raf = 0;
    const effect = this.#effect!;
    try {
      effect.setSource(this.#frameSource());
      // Under reduced motion the lens still follows the pointer but its edge
      // doesn't wobble.
      effect.render(this.#reducedMotion?.matches ? 0 : now / 1000);
    } catch (error) {
      // Typically a SecurityError: a cross-origin source without CORS headers
      // can be shown but not read back.
      this.#fail(error);
      return;
    }
    // Keep going while there's motion: a playing video or the lens. The effect
    // only redraws when there's a new video frame, so this costs little.
    const video = this.#media instanceof HTMLVideoElement ? this.#media : null;
    if ((video && !video.paused) || effect.hovering) this.#requestFrame();
  };

  /** Match the video and the render loop to visibility and the props. */
  #update = () => {
    const animate = this.#visible && !this.paused && !this.#reducedMotion?.matches;
    const video = this.#media instanceof HTMLVideoElement ? this.#media : null;
    if (video) {
      video.playbackRate = this.playbackRate;
      if (animate && video.paused) void video.play().catch(() => {});
      if (!animate && !video.paused) video.pause();
    }
    if (!this.#live && this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
    this.#requestFrame();
  };

  #fail(error: unknown) {
    if (this.#failed) return;
    this.#failed = true;
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#canvas.hidden = true;
    if (this.#media) this.#media.style.cssText = FALLBACK_MEDIA;
    this.#error(
      error instanceof Error && error.name === 'SecurityError'
        ? "the source can't be read back (cross-origin without CORS headers); showing it unprocessed"
        : `${error instanceof Error ? error.message : error}; showing the source unprocessed`,
      error,
    );
    this.#update();
  }

  #error(message: string, cause?: unknown) {
    console.warn(`[pixel-video] ${message}`);
    this.#lastError = { message, cause };
    this.dispatchEvent(
      new CustomEvent('pixel-video-error', { detail: { message, cause }, bubbles: true }),
    );
  }
}

/** Register the element (idempotent). Pass a name to use another tag. */
export function definePixelVideo(name = TAG) {
  if (typeof customElements === 'undefined' || customElements.get(name)) return;
  customElements.define(
    name,
    name === TAG ? PixelVideoElement : class extends PixelVideoElement {},
  );
}

declare global {
  interface HTMLElementTagNameMap {
    'pixel-video': PixelVideoElement;
  }
}
