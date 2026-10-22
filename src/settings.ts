// Every knob of the effect, with the defaults of the lab prototype
// (overnice-2026 → lab/src/prototypes/datocms/pixel-video/params.ts). The
// lab's "Copy React snippet" / "Copy HTML snippet" buttons produce objects of
// exactly this shape, so a look tuned in the lab pastes straight into
// `settings`.
//
// Colours are DatoCMS palette tokens with their hex as the fallback,
// `var(--color-orange-light-5, #ff6d00)`, so the site's own variables win
// where they exist. Plain hex (#rgb, #rrggbb, with or without alpha) works
// too.

export interface PixelVideoSettings {
  /** Blur the source before posterising, in px (0–10). No-op in Safari. */
  smoothing: number;
  /** Brightness (0–255) below which a pixel is background. */
  tMid: number;
  /** Brightness below which a pixel is a midtone (above: highlight). */
  tHigh: number;

  bgSize: number;
  bgFill: string;
  bgStroke: string;
  /** Draw the background layer's squares without strokes. */
  bgStrokeDisabled: boolean;

  midSize: number;
  midFill: string;
  midStroke: string;
  /** Draw the midtones layer's squares without strokes. */
  midStrokeDisabled: boolean;

  highSize: number;
  highFill: string;
  highStroke: string;
  /** Draw the highlights layer's squares without strokes. */
  highStrokeDisabled: boolean;

  /** Stroke weight of every layer's squares (and the lens), in px. A layer
   *  with `…StrokeDisabled` set has none. */
  strokeWeight: number;

  /** Show the pointer lens. */
  hover: boolean;
  hoverRadius: number;
  hoverDistortion: number;
  /** Speed of the lens edge's wobble. */
  hoverSpeed: number;
  hoverPixelSize: number;
  hoverFalloff: number;
}

// The DatoCMS palette's orange / brown / yellow (cartoon eyes on orange).
const ORANGE = 'var(--color-orange-light-5, #ff6d00)';
const BROWN = 'var(--color-brown-5, #351615)';
const YELLOW = 'var(--color-yellow-5, #e7d864)';

export const DEFAULTS: Readonly<PixelVideoSettings> = Object.freeze({
  smoothing: 0,
  tMid: 105,
  tHigh: 161,

  bgSize: 8,
  bgFill: BROWN,
  bgStroke: BROWN,
  bgStrokeDisabled: false,

  midSize: 10,
  midFill: ORANGE,
  midStroke: BROWN,
  midStrokeDisabled: false,

  highSize: 12,
  highFill: YELLOW,
  highStroke: BROWN,
  highStrokeDisabled: false,

  strokeWeight: 1,

  hover: true,
  hoverRadius: 160,
  hoverDistortion: 30,
  hoverSpeed: 1,
  hoverPixelSize: 24,
  hoverFalloff: 60,
});

const HEX = '#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})';
/** `#hex`, or `var(--name)` / `var(--name, #hex)`. */
export const COLOR = new RegExp(`^(?:${HEX}|var\\(\\s*--[\\w-]+\\s*(?:,\\s*${HEX}\\s*)?\\))$`, 'i');

/**
 * Defaults ← settings. Unknown keys, values of the wrong type and colours that
 * aren't hex or a `var()` are dropped (with a warning), so a pasted lab export
 * can never break the effect.
 */
export function resolveSettings(settings?: Partial<PixelVideoSettings> | null): PixelVideoSettings {
  const out: PixelVideoSettings = { ...DEFAULTS };
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (!(key in DEFAULTS)) {
      warn(`ignoring unknown setting "${key}"`);
      continue;
    }
    const expected = typeof DEFAULTS[key as keyof PixelVideoSettings];
    if (typeof value !== expected || (expected === 'number' && !Number.isFinite(value))) {
      warn(`ignoring "${key}": expected a ${expected}, got ${JSON.stringify(value)}`);
      continue;
    }
    if (expected === 'string' && !COLOR.test(value as string)) {
      warn(`ignoring "${key}": ${JSON.stringify(value)} is not a hex colour or var(--token, #hex)`);
      continue;
    }
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

const warn = (msg: string) => console.warn(`[pixel-video] ${msg}`);
