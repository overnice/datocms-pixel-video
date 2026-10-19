// Framework-free entry: the element, the effect and the settings.
export { PixelVideoElement, definePixelVideo, isImageSource, TAG } from './element';
export {
  mountPixelVideo,
  type FrameSource,
  type MountOptions,
  type PixelVideoEffect,
} from './core';
export {
  DEFAULTS,
  PRESETS,
  resolveSettings,
  type PixelVideoSettings,
  type PresetName,
} from './settings';
