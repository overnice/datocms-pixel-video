// <pixel-video>: the effect as a drop-in custom element. It owns everything
// the lab page did around the effect: the hidden source <video>/<img>, the
// render loop, sizing to the source's aspect ratio. On top of that it only
// runs while on screen, honours prefers-reduced-motion, and falls back to the
// plain video/image if WebGL2 is missing or the source can't be read (CORS).
//
//   <pixel-video src="/hero.mp4" poster="/hero.jpg" preset="Mono"></pixel-video>
//
// Attributes: src, type ("video" | "image"; otherwise guessed from the URL),
// poster, preset, settings (JSON), paused, playback-rate, crossorigin.
// Properties: the same, plus `src` may be an array (first playable wins) and
// `settings` takes an object. Several sources can also be given as light-DOM
// <source> children, like a <video>.

import { mountPixelVideo } from './core';
import { resolveSettings, type PixelVideoSettings } from './settings';

type Effect = ReturnType<typeof mountPixelVideo>;
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

// SSR-safe: importing this module on the server must not touch the DOM.
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;

export class PixelVideoElement extends Base {
  static observedAttributes = [
    'src',
    'type',
    'poster',
    'preset',
    'settings',
    'paused',
    'playback-rate',
    'crossorigin',
  ];

  /** Live settings, read by the effect every frame (mutated in place). */
  readonly values: PixelVideoSettings = resolveSettings();

  #src: string | string[] | null = null;
  #settings: Partial<PixelVideoSettings> | null = null;
  #canvas!: HTMLCanvasElement;
  #effect: Effect | null = null;
  #media: Media | null = null;
  #poster: HTMLImageElement | null = null;
  #failed = false;
  #lastError: { message: string; cause?: unknown } | null = null;
  #raf = 0;
  #onScreen = false;
  #io: IntersectionObserver | null = null;
  #reducedMotion: MediaQueryList | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style><canvas part="canvas"></canvas>`;
    this.#canvas = root.querySelector('canvas')!;
  }

  // ── properties ────────────────────────────────────────────────────────────

  /** A URL, or several (first playable wins). Overrides the attribute. */
  get src(): string | string[] | null {
    return this.#src ?? this.getAttribute('src');
  }
  set src(value: string | string[] | null) {
    const same = JSON.stringify(value) === JSON.stringify(this.#src);
    this.#src = value;
    if (!same) this.#load();
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

  get preset() {
    return this.getAttribute('preset');
  }
  set preset(value: string | null) {
    this.#reflect('preset', value);
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

  /** The hidden source element (a <video> or <img>), once loaded. */
  get media(): Media | null {
    return this.#media;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback() {
    // Properties set before the element was defined (e.g. by a framework)
    // shadow the accessors; re-run them through the setters.
    for (const key of ['src', 'settings', 'preset', 'paused', 'playbackRate'] as const) {
      if (Object.prototype.hasOwnProperty.call(this, key)) {
        const value = (this as Record<string, unknown>)[key];
        delete (this as Record<string, unknown>)[key];
        (this as Record<string, unknown>)[key] = value;
      }
    }

    this.#applySettings();
    try {
      this.#effect = mountPixelVideo(this.#canvas, this.values);
    } catch (error) {
      this.#fail(error);
    }
    this.#load();

    this.#reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.#reducedMotion.addEventListener('change', this.#update);
    document.addEventListener('visibilitychange', this.#update);
    this.#io = new IntersectionObserver(([entry]) => {
      this.#onScreen = entry.isIntersecting;
      this.#update();
    });
    this.#io.observe(this);
  }

  disconnectedCallback() {
    this.#io?.disconnect();
    this.#reducedMotion?.removeEventListener('change', this.#update);
    document.removeEventListener('visibilitychange', this.#update);
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
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
      case 'preset':
      case 'settings':
        this.#applySettings();
        break;
      case 'paused':
      case 'playback-rate':
        this.#update();
        break;
      default: // src, type, poster, crossorigin
        if (name !== 'src' || this.#src === null) this.#load();
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #reflect(name: string, value: string | null) {
    if (value === null) this.removeAttribute(name);
    else this.setAttribute(name, value);
  }

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
    Object.assign(this.values, resolveSettings(settings, this.preset));
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

  #load() {
    if (!this.isConnected) return;
    this.#dropMedia();
    const sources = this.#sources();
    const crossOrigin = this.getAttribute('crossorigin') ?? 'anonymous';
    const root = this.shadowRoot!;

    const poster = this.getAttribute('poster');
    if (poster) {
      this.#poster = Object.assign(new Image(), { crossOrigin, src: poster });
      this.#poster.addEventListener('load', () => this.#fit(this.#poster!), { once: true });
    }

    if (!sources.length) {
      this.#update();
      return;
    }

    let media: Media;
    if (isImageSource(sources.map((s) => s.src), this.getAttribute('type'))) {
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
      // A paused video only decodes its first frame once it has data; redraw
      // then (the loop may be idle under reduced motion).
      video.addEventListener('loadeddata', this.#update);
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
    this.dispatchEvent(new Event('load'));
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

  #tick = (now: number) => {
    this.#raf = requestAnimationFrame(this.#tick);
    try {
      this.#effect!.setSource(this.#frameSource());
      this.#effect!.render(now / 1000);
    } catch (error) {
      // Typically a SecurityError: a cross-origin source without CORS headers
      // can be shown but not read back.
      this.#fail(error);
    }
  };

  /** Start/stop the render loop and the video to match visibility & props. */
  #update = () => {
    const live = this.isConnected && this.#onScreen && !document.hidden;
    const animate = live && !this.paused && !this.#reducedMotion?.matches;

    const runLoop = live && !this.#failed && !!this.#effect;
    if (runLoop && !this.#raf) this.#raf = requestAnimationFrame(this.#tick);
    if (!runLoop && this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
    // Still draw one frame when static (paused / reduced motion / off-loop).
    if (!runLoop && this.#effect && !this.#failed && this.isConnected) {
      try {
        this.#effect.setSource(this.#frameSource());
        this.#effect.render(0);
      } catch (error) {
        this.#fail(error);
      }
    }

    const video = this.#media instanceof HTMLVideoElement ? this.#media : null;
    if (!video) return;
    video.playbackRate = this.playbackRate;
    if (animate && video.paused) void video.play().catch(() => {});
    if (!animate && !video.paused) video.pause();
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
  customElements.define(name, name === TAG ? PixelVideoElement : class extends PixelVideoElement {});
}

declare global {
  interface HTMLElementTagNameMap {
    'pixel-video': PixelVideoElement;
  }
}
