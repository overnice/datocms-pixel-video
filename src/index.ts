// Framework-free entry: the element, the effect and the settings.
export { PixelVideoElement, definePixelVideo, isImageSource, TAG } from './element';
export {
  mountPixelVideo,
  parseColor,
  type FrameSource,
  type MountOptions,
  type PixelVideoEffect,
} from './core';
export { DEFAULTS, resolveSettings, type PixelVideoSettings } from './settings';
