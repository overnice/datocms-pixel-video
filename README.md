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
npm i github:overnice/datocms-pixel-video#v0.1.0
```

## Use

### React (and Next.js)

```tsx
import { PixelVideo } from '@overnice/datocms-pixel-video/react';

<PixelVideo
  src={['/hero.webm', '/hero.mp4']}  // or one URL; an image URL works too
  poster="/hero.jpg"                 // optional: drawn while the video loads
  settings={{ highFill: '#e3d55a', hoverRadius: 200 }}
  className="hero-video"
/>
```

The wrapper is a client component (`'use client'`) and is safe to render on the
server.

### Any HTML page

```html
<script type="module">
  import '@overnice/datocms-pixel-video/register';
</script>

<pixel-video src="/hero.mp4" preset="Mono"></pixel-video>

<!-- Several formats, like a <video>: -->
<pixel-video>
  <source src="/hero.webm" type="video/webm" />
  <source src="/hero.mp4" type="video/mp4" />
</pixel-video>
```

If there's no bundler, load the single file `dist/pixel-video.global.js` with a
plain `<script>` tag.

## Tuning the look in the lab

Tune the look in the Overnice lab prototype ("Pixel video"), not by hand:

1. Open the prototype. Upload your own video or image (or drop it onto the page)
   and adjust the panel until it looks right.
2. Click **Copy React snippet** or **Copy HTML snippet** at the top of the panel.
   You get the component with every setting filled in. If you uploaded a file,
   its name is used as the `src`.
3. Paste the snippet into your code and point `src` at the real file.

The panel's **Export → Copy values (JSON)** works too: `settings` (the prop, or
the attribute as JSON) accepts that object as it is. Unknown keys and values of
the wrong type are ignored with a console warning, so a pasted export can't
break the component.

## Props / attributes

| React prop     | HTML attribute            | Notes                                                                                |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `src`          | `src`                     | URL, or an array of URLs (React/property only); or `<source>` children               |
| `type`         | `type`                    | `"video"` / `"image"`. By default it's an image if the URL ends in .jpg/.png/.webp/… |
| `poster`       | `poster`                  | Image drawn, pixelated, until the video has a frame                                   |
| `preset`       | `preset`                  | `"Fine highlights"`, `"Dithered"`, `"Mono"`. Applied before `settings`                 |
| `settings`     | `settings`                | Any subset of the settings below (JSON string as an attribute)                        |
| `paused`       | `paused`                  | Pause the video                                                                       |
| `playbackRate` | `playback-rate`           |                                                                                      |
| `crossOrigin`  | `crossorigin`             | Default `anonymous` (see CORS below)                                                  |
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

- **CORS.** The effect reads every frame's pixels, so a video or image from
  another domain needs `Access-Control-Allow-Origin` headers. Check this if the
  files are on a CDN. Without the headers, the element shows the plain source and
  reports an error (`onError`) instead of breaking.
- **No WebGL2.** In this case it shows the plain source the same way.
- **Performance.** The effect only renders and plays while it's on screen and
  the tab is visible. Each frame is processed at no more than 400px on its
  longest side, so short, small sources are cheapest.
- **Reduced motion.** When `prefers-reduced-motion` is set, the video stays on
  its first frame. Hover still works.
- **Touch.** There's no hover on touch screens, so the lens shows only while a
  finger is down. Scrolling over the element still works.
- **Autoplay.** Videos are always muted and inline, which is what autoplay needs.

## Develop

```bash
npm install
npm run dev      # demo/ — web component page + React page (/react.html)
npm run check    # TypeScript
npm test         # unit tests
npm run build    # dist/
```

`src/core.ts` is the effect, taken unchanged from the lab prototype.
`src/element.ts` wraps it as the custom element, and `src/react.tsx` wraps the
element for React. To release, bump `version`, tag it `vX.Y.Z` and push the tag.
Consumers pin to that tag.
