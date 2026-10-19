// Every knob of the effect, with the defaults and presets of the lab
// prototype (overnice-2026 → lab/src/prototypes/datocms/pixel-video/params.ts).
// The lab's "Copy React snippet" / "Copy HTML snippet" / "Copy values (JSON)"
// buttons produce objects of exactly this shape, so a look tuned in the lab
// pastes straight into `settings`.

export interface PixelVideoSettings {
  /** Blur the source before posterising, in px (0–10). No-op in Safari. */
  smoothing: number;
  /** Floyd–Steinberg dither the source to pure black / white first. */
  dither: boolean;
  /** Brightness (0–255) below which a pixel is background. */
  tShadow: number;
  /** Brightness below which a pixel is a shadow. */
  tMid: number;
  /** Brightness below which a pixel is a midtone (above: highlight). */
  tHigh: number;

  bgSize: number;
  bgFill: string;
  bgStroke: string;
  bgStrokeWeight: number;

  shadowSize: number;
  shadowFill: string;
  shadowStroke: string;
  shadowStrokeWeight: number;

  midSize: number;
  midFill: string;
  midStroke: string;
  midStrokeWeight: number;

  highSize: number;
  highFill: string;
  highStroke: string;
  highStrokeWeight: number;

  /** Show the pointer lens. */
  hover: boolean;
  hoverRadius: number;
  hoverDistortion: number;
  /** Speed of the lens edge's wobble. */
  hoverSpeed: number;
  hoverPixelSize: number;
  hoverFalloff: number;
}

// Colours sampled from the reference recording (cartoon eyes on orange).
const ORANGE = '#ff6100';
const BROWN = '#3a1712';
const YELLOW = '#e3d55a';

export const DEFAULTS: Readonly<PixelVideoSettings> = Object.freeze({
  smoothing: 0,
  dither: false,
  tShadow: 34,
  tMid: 105,
  tHigh: 161,

  bgSize: 12,
  bgFill: ORANGE,
  bgStroke: BROWN,
  bgStrokeWeight: 0,

  shadowSize: 8,
  shadowFill: BROWN,
  shadowStroke: BROWN,
  shadowStrokeWeight: 1,

  midSize: 10,
  midFill: ORANGE,
  midStroke: BROWN,
  midStrokeWeight: 0,

  highSize: 12,
  highFill: YELLOW,
  highStroke: BROWN,
  highStrokeWeight: 1,

  hover: true,
  hoverRadius: 160,
  hoverDistortion: 30,
  hoverSpeed: 1,
  hoverPixelSize: 24,
  hoverFalloff: 60,
});

export const PRESETS = {
  'Fine highlights': { bgSize: 16, shadowSize: 16, midSize: 8, highSize: 4, highStrokeWeight: 0.5 },
  Dithered: {
    dither: true,
    smoothing: 1,
    bgSize: 4,
    highSize: 4,
    highStrokeWeight: 0,
    hoverPixelSize: 12,
  },
  Mono: {
    bgFill: '#111111',
    shadowFill: '#444444',
    midFill: '#888888',
    highFill: '#f2f2f2',
    shadowStroke: '#111111',
    highStroke: '#111111',
  },
} satisfies Record<string, Partial<PixelVideoSettings>>;

export type PresetName = keyof typeof PRESETS;

/**
 * Defaults ← preset ← settings. Unknown keys and values of the wrong type are
 * dropped (with a warning), so a pasted lab export can never break the effect.
 */
export function resolveSettings(
  settings?: Partial<PixelVideoSettings> | null,
  preset?: string | null,
): PixelVideoSettings {
  const out: PixelVideoSettings = { ...DEFAULTS };
  if (preset) {
    const p = (PRESETS as Record<string, Partial<PixelVideoSettings>>)[preset];
    if (p) Object.assign(out, p);
    else warn(`unknown preset "${preset}" (have: ${Object.keys(PRESETS).join(', ')})`);
  }
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
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

const warn = (msg: string) => console.warn(`[pixel-video] ${msg}`);
