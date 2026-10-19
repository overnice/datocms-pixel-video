# datocms-pixel-video

A video or image posterised into four brightness layers (background, shadows,
midtones and highlights). Each layer is a pixel mosaic with its own pixel size,
fill and stroke. On hover, an animated lens shows a coarser grid. It renders
with WebGL2 and has no dependencies.

The package gives you a `<pixel-video>` custom element that works in any site or
framework, plus a React wrapper.

## Install

The package is private, so install it straight from GitHub. The build runs on
install.

```bash
npm i github:overnice/datocms-pixel-video#v0.3.0
```

## Use

### React (and Next.js)

```tsx
import { PixelVideo } from '@overnice/datocms-pixel-video/react';

<PixelVideo
  src={['/hero.webm', '/hero.mp4']} // or one URL; an image URL works too
  poster="/hero.jpg" // optional: drawn while the video loads
  settings={{ highFill: 'var(--color-yellow-0, #fdfff5)', hoverRadius: 200 }}
  className="hero-video"
/>;
```

The wrapper is a client component (`'use client'`) and is safe to render on the
server.

### Any HTML page

```html
<script type="module">
  import '@overnice/datocms-pixel-video/register';
</script>

<pixel-video src="/hero.mp4"></pixel-video>

<!-- Several formats, like a <video>: -->
<pixel-video>
  <source src="/hero.webm" type="video/webm" />
  <source src="/hero.mp4" type="video/mp4" />
</pixel-video>
```

If there's no bundler, load the single file `dist/pixel-video.global.js` with a
plain `<script>` tag.

### Astro

Use the custom element directly. It needs no integration and only adds a small
client script:

```astro
---
// src/components/PixelHero.astro
const settings = { highFill: '#e3d55a', hoverRadius: 200 }; // or a lab snippet's object
---

<pixel-video
  src="/videos/hero.mp4"
  poster="/videos/hero.jpg"
  settings={JSON.stringify(settings)}
></pixel-video>

<script>
  import '@overnice/datocms-pixel-video/register';
</script>
```

- **The `<script>` defines the element.** Astro bundles it and includes it once
  per page, however many times the component is used. The element renders
  nothing until that script runs, so give it a size if it's above the fold (its
  default 16:9 box holds the space until the video loads).
- **Pass `settings` with `JSON.stringify`.** Astro writes attributes as strings,
  so an object has to be serialised. The lab's **Copy HTML snippet** already
  gives you the JSON. Paste its `<pixel-video>` tag into a `.astro` file as it is.
- **Several formats:** use `<source>` children, as in plain HTML.
- **Video files** can go in `public/` (`src="/videos/hero.mp4"`), or you can
  import them so they get a hashed URL:
  `import heroMp4 from '../assets/hero.mp4?url';` and then `src={heroMp4}`.
- **View transitions (`<ClientRouter />`):** nothing extra is needed. The element
  tears down when it's removed from the page and sets itself up again when it's
  added.

**From DatoCMS.** Query the video field's MP4 rendition. `streamingUrl` is HLS,
which a plain `<video>` can't play outside Safari. The effect works at no more
than 400px, so a low rendition is enough:

```graphql
heroVideo {
  video {
    mp4Url(res: low)
    thumbnailUrl(width: 800)
  }
}
```

```astro
<pixel-video
  src={heroVideo.video.mp4Url}
  poster={heroVideo.video.thumbnailUrl}
  settings={JSON.stringify(settings)}
></pixel-video>
```

`mp4Url` is `null` unless MP4 renditions are turned on for the DatoCMS project,
so check for that. If the file is served from a CDN, it also needs CORS headers
(see below).

**As a React island.** If the site already uses `@astrojs/react` and you want
the `<PixelVideo>` props, render the wrapper with a client directive, for
example `<PixelVideo client:visible src="/videos/hero.mp4" settings={settings} />`.
With `client:visible`, React loads only when the video scrolls into view. The
custom element is lighter (no React on the page), so prefer it unless you need
React state around the video.

## Tuning the look in the lab

Tune the look in the Overnice lab prototype ("Pixel video"), not by hand:

1. Open the prototype. Upload your own video or image (or drop it onto the page)
   and adjust the panel until it looks right. Colours are picked from the
   DatoCMS palette (the Figma colour variables), not typed in.
2. Click **Copy React snippet** or **Copy HTML snippet** at the top of the panel.
   You get the component with every setting filled in. If you uploaded a file,
   its name is used as the `src`.
3. Paste the snippet into your code and point `src` at the real file.

Unknown keys, values of the wrong type and colours that aren't hex or a `var()`
are ignored with a console warning, so a pasted snippet can't break the
component.

## Colours

Every colour setting is a palette token with its hex as the fallback, exactly
as the lab writes it:

```ts
bgFill: 'var(--color-orange-light-5, #ff6d00)',
midStroke: 'var(--color-orange-deep-1, #42180f1f)', // see-through steps carry alpha
```

- **The site's variables win.** The element reads each variable from the CSS
  where it sits, so if the site defines `--color-orange-light-5`, that value is
  used, and a section that redefines it recolours the video too. Where it isn't
  defined, the hex fallback applies.
- **When the site changes those variables** (for example a theme switch), call
  `element.refreshColors()` (in React, through a `ref`). The element re-reads
  them automatically when it's attached and whenever `settings` change.
- **See-through colours** (palette steps 1–4) are drawn over the layer beneath,
  like stacked layers in Figma. A see-through background lets the page show
  through.
- Plain hex (`#rrggbb`, `#rrggbbaa`) works too, but use palette tokens so the
  site stays on palette.

## Props / attributes

| React prop     | HTML attribute            | Notes                                                                                |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `src`          | `src`                     | URL, or an array of URLs (React/property only); or `<source>` children               |
| `type`         | `type`                    | `"video"` / `"image"`. By default it's an image if the URL ends in .jpg/.png/.webp/… |
| `poster`       | `poster`                  | Image drawn, pixelated, until the video has a frame                                  |
| `settings`     | `settings`                | Any subset of the settings below (JSON string as an attribute)                       |
| `paused`       | `paused`                  | Pause the video                                                                      |
| `playbackRate` | `playback-rate`           |                                                                                      |
| `crossOrigin`  | `crossorigin`             | Default `anonymous` (see CORS below)                                                 |
| `onLoad`       | `load` event              | The source's size is known                                                           |
| `onError`      | `pixel-video-error` event | `detail: { message, cause }`. The effect fell back to the plain source               |

Settings, with their defaults in `src/settings.ts`:

- **Source:** `smoothing`, `dither`, and the thresholds `tShadow`, `tMid`, `tHigh`.
- **Each layer:** `{bg,shadow,mid,high}` + `Size`, `Fill`, `Stroke`, `StrokeWeight`.
- **Hover lens:** `hover`, `hoverRadius`, `hoverDistortion`, `hoverSpeed`,
  `hoverPixelSize`, `hoverFalloff`.

## Layout

The element is `display: block` and takes the source's aspect ratio (16:9 until
the source loads). Your own CSS takes priority. For example,
`style="height: 400px; aspect-ratio: auto"` fixes the height, and the picture is
contain-fitted inside it, with the area around it filled in the background colour.

## Behaviour worth knowing

- **Lazy loading.** The source starts loading when the element comes within
  about a screen's height of the viewport, much like `loading="lazy"`. Elements
  already on screen load straight away.
- **Performance.** It only plays and draws while it's on screen and the tab is
  visible, and it only redraws when something has changed: a new video frame, a
  setting, the size, or the pointer. Paused videos and still images cost nothing
  once drawn. Each frame is shrunk on the GPU (to 400px on its longest side) and
  sorted into layers in a shader, so nothing is read back to the CPU. The one
  exception is `dither`, which is sequential and runs on the CPU, so use it on
  small or short sources.
- **Many on one page.** Each element uses its own WebGL context, and browsers
  allow about 16 at once. Six or so per page is plenty.
- **CORS.** The effect reads the source's pixels, so a video or image from
  another domain needs `Access-Control-Allow-Origin` headers. Check this if the
  files are on a CDN. Without the headers, the element shows the plain source and
  reports an error (`onError`) instead of breaking.
- **No WebGL2.** In this case it shows the plain source the same way. If the GPU
  resets (it happens on mobile), the effect restores itself.
- **Reduced motion.** When `prefers-reduced-motion` is set, the video stays on
  its first frame and the lens edge doesn't wobble. The lens still follows the
  pointer.
- **Accessibility.** The element is decorative by default: screen readers skip
  it. If the picture carries meaning, label the element:
  `<pixel-video role="img" aria-label="…">`.
- **Touch.** There's no hover on touch screens, so the lens shows only while a
  finger is down. Scrolling over the element still works.
- **Autoplay.** Videos are always muted and inline, which is what autoplay needs.
  The hidden video has picture-in-picture and casting turned off.

## Custom render loop

`<pixel-video>` covers normal use. For something else, such as drawing into
your own canvas from your own source, use the effect directly:

```ts
import { mountPixelVideo, resolveSettings } from '@overnice/datocms-pixel-video';

const settings = resolveSettings({ highFill: '#e3d55a' });
const effect = mountPixelVideo(canvas, settings, { onInvalidate: () => requestDraw() });
effect.setSource(videoElement);
// Each animation frame: draws only if something changed; returns whether it did.
effect.render(performance.now() / 1000);
// After changing `settings` in place:
effect.invalidate();
// When done:
effect.destroy();
```

## Develop

```bash
npm install
npm run dev      # demo/ — web component page + React page (/react.html)
npm run check    # TypeScript
npm test         # unit tests
npm run format   # Prettier
npm run build    # dist/
```

`src/core.ts` is the effect. It gives the same image as the lab prototype,
pixel for pixel, but does the work on the GPU and only when needed.
`src/element.ts` wraps it as the custom element, and `src/react.tsx` wraps the
element for React. CI runs the formatting check, types, tests and build on every
push. To release, bump `version`, then publish a GitHub release tagged `vX.Y.Z`.
Consumers pin to that tag.
