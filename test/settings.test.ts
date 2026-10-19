import { describe, expect, it, vi } from 'vitest';
import { COLOR, DEFAULTS, resolveSettings } from '../src/settings';
import { parseColor } from '../src/core';
import { isImageSource } from '../src/element';

describe('resolveSettings', () => {
  it('starts from the defaults', () => {
    expect(resolveSettings()).toEqual(DEFAULTS);
  });

  it('defaults to palette tokens with hex fallbacks', () => {
    expect(DEFAULTS.bgFill).toBe('var(--color-brown-5, #351615)');
    expect(DEFAULTS.midFill).toBe('var(--color-orange-light-5, #ff6d00)');
    expect(DEFAULTS.highFill).toBe('var(--color-yellow-5, #e7d864)');
  });

  it('applies settings over the defaults', () => {
    const out = resolveSettings({ bgFill: 'var(--color-purple-light-5, #9e8ef5)', highSize: 4 });
    expect(out.bgFill).toBe('var(--color-purple-light-5, #9e8ef5)');
    expect(out.highSize).toBe(4);
    expect(out.hoverRadius).toBe(DEFAULTS.hoverRadius);
  });

  it('takes a full lab snippet as-is', () => {
    const lab = { ...DEFAULTS, highSize: 4, strokeWeight: 0, midStroke: '#42180f1f' };
    expect(resolveSettings(JSON.parse(JSON.stringify(lab)))).toEqual(lab);
  });

  it('ignores settings that no longer exist (shadow layer, dither, per-layer stroke weights)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      resolveSettings({ shadowFill: '#000', dither: true, bgStrokeWeight: 3 } as never),
    ).toEqual(DEFAULTS);
    warn.mockRestore();
  });

  it('drops unknown keys, wrong types and non-colours with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = resolveSettings({
      nope: 1,
      bgSize: '12',
      hover: 'yes',
      midSize: NaN,
      bgFill: 'red',
      midFill: 'var(--x, red)',
    } as never);
    expect(out).toEqual(DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(6);
    warn.mockRestore();
  });
});

describe('colours', () => {
  it('accepts hex and var() with a hex fallback', () => {
    for (const c of ['#fff', '#ffff', '#42180f', '#42180f1f', 'var(--a)', 'var( --a-b , #abc )'])
      expect(COLOR.test(c), c).toBe(true);
    for (const c of ['red', '#12345', 'var(--a, red)', 'rgb(0 0 0)'])
      expect(COLOR.test(c), c).toBe(false);
  });

  it('parses to 0–1 RGBA, var() via its fallback', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#f008')).toEqual([1, 0, 0, 0x88 / 255]);
    expect(parseColor('var(--color-orange-deep-1, #42180f1f)')).toEqual([
      0x42 / 255,
      0x18 / 255,
      0x0f / 255,
      0x1f / 255,
    ]);
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0, 0.5]);
    expect(parseColor('nonsense')).toEqual([0, 0, 0, 0]);
  });
});

describe('isImageSource', () => {
  it('guesses from the URL', () => {
    expect(isImageSource(['/a.jpg'])).toBe(true);
    expect(isImageSource(['/a.webp?w=800'])).toBe(true);
    expect(isImageSource(['/a.mp4'])).toBe(false);
    expect(isImageSource(['https://stream.example/abc'])).toBe(false);
  });

  it('lets type override the guess', () => {
    expect(isImageSource(['https://cdn.example/abc'], 'image')).toBe(true);
    expect(isImageSource(['/a.png'], 'video')).toBe(false);
  });
});
