import { defineConfig } from 'tsup';

export default defineConfig([
  // npm entries: ESM + types; React stays external (a peer dependency).
  {
    entry: { index: 'src/index.ts', register: 'src/register.ts', react: 'src/react.tsx' },
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'es2022',
    external: ['react'],
  },
  // One file for a plain <script src> (no bundler): defines <pixel-video>.
  {
    entry: { 'pixel-video': 'src/register.ts' },
    format: ['iife'],
    globalName: 'PixelVideo',
    minify: true,
    target: 'es2022',
  },
]);
