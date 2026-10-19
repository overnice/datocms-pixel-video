'use client';
// React wrapper around <pixel-video>. Everything goes through properties set
// in an effect, so it behaves the same on React 18 and 19, and renders an
// empty <pixel-video> on the server (the element upgrades on hydration).

import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type HTMLAttributes,
} from 'react';
import { definePixelVideo, TAG, type PixelVideoElement } from './element';
import type { PixelVideoSettings, PresetName } from './settings';

// Defined on import in the browser, so the element is upgraded as soon as
// React creates it, before any of the effects below set its properties.
definePixelVideo();

export interface PixelVideoProps extends Omit<HTMLAttributes<HTMLElement>, 'onError' | 'onLoad'> {
  /** Video or image URL, or several (e.g. WebM then MP4; first playable wins). */
  src: string | string[];
  /** Force the source kind. Default: an image if the URL looks like one. */
  type?: 'video' | 'image';
  /** Image drawn (pixelated) while the video loads. */
  poster?: string;
  /** A built-in preset, applied before `settings`. */
  preset?: PresetName;
  /** Any subset of the settings — paste the lab's export here. */
  settings?: Partial<PixelVideoSettings>;
  paused?: boolean;
  playbackRate?: number;
  /** Default "anonymous": cross-origin sources need CORS headers to be read. */
  crossOrigin?: 'anonymous' | 'use-credentials';
  /** The source's size is known (the box has taken its aspect ratio). */
  onLoad?: () => void;
  /** The effect fell back to the plain source, or the source failed. */
  onError?: (message: string, cause?: unknown) => void;
}

export const PixelVideo = forwardRef<PixelVideoElement | null, PixelVideoProps>(
  function PixelVideo(
    { src, type, poster, preset, settings, paused, playbackRate, crossOrigin, onLoad, onError, ...rest },
    forwarded,
  ) {
    const ref = useRef<PixelVideoElement>(null);
    useImperativeHandle(forwarded, () => ref.current!, []);

    const set = <K extends keyof PixelVideoElement>(key: K, value: PixelVideoElement[K]) => {
      if (ref.current) ref.current[key] = value;
    };
    const attr = (name: string, value: string | undefined) => {
      if (!ref.current) return;
      if (value === undefined) ref.current.removeAttribute(name);
      else ref.current.setAttribute(name, value);
    };

    // Attributes that change how the source loads go first, then the source.
    useEffect(() => attr('type', type), [type]);
    useEffect(() => attr('poster', poster), [poster]);
    useEffect(() => attr('crossorigin', crossOrigin), [crossOrigin]);
    const srcKey = JSON.stringify(src);
    useEffect(() => set('src', src), [srcKey]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => attr('preset', preset), [preset]);
    // Compared by value, so an inline object literal doesn't re-apply each render.
    const settingsKey = JSON.stringify(settings ?? null);
    useEffect(() => set('settings', settings ?? null), [settingsKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => set('paused', !!paused), [paused]);
    useEffect(() => attr('playback-rate', playbackRate?.toString()), [playbackRate]);

    const handlers = useRef({ onLoad, onError });
    handlers.current = { onLoad, onError };
    useEffect(() => {
      const node = ref.current!;
      const load = () => handlers.current.onLoad?.();
      const error = (e: Event) => {
        const { message, cause } = (e as CustomEvent<{ message: string; cause?: unknown }>).detail;
        handlers.current.onError?.(message, cause);
      };
      // Reported before this effect could listen (e.g. no WebGL2 on mount).
      if (node.error) handlers.current.onError?.(node.error.message, node.error.cause);
      node.addEventListener('load', load);
      node.addEventListener('pixel-video-error', error);
      return () => {
        node.removeEventListener('load', load);
        node.removeEventListener('pixel-video-error', error);
      };
    }, []);

    return createElement(TAG, { ...rest, ref });
  },
);

export type { PixelVideoElement, PixelVideoSettings, PresetName };
export { DEFAULTS, PRESETS } from './settings';
