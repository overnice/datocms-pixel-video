import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS, PRESETS, resolveSettings } from '../src/settings';
import { isImageSource } from '../src/element';

describe('resolveSettings', () => {
  it('starts from the defaults', () => {
    expect(resolveSettings()).toEqual(DEFAULTS);
  });

  it('applies preset, then settings', () => {
    const out = resolveSettings({ bgFill: '#000000' }, 'Mono');
    expect(out.shadowFill).toBe(PRESETS.Mono.shadowFill);
    expect(out.bgFill).toBe('#000000');
    expect(out.hoverRadius).toBe(DEFAULTS.hoverRadius);
  });

  it('takes a full lab "Copy values (JSON)" export as-is', () => {
    const lab = { ...DEFAULTS, highSize: 4, dither: true };
    expect(resolveSettings(JSON.parse(JSON.stringify(lab)))).toEqual(lab);
  });

  it('drops unknown keys, wrong types and unknown presets with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = resolveSettings(
      { nope: 1, bgSize: '12', hover: 'yes', midSize: NaN } as never,
      'Nope',
    );
    expect(out).toEqual(DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
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
