# image-panel

A small, dependency-free image viewer web component. It shows one image at a time, cross-fades between them, and can auto-advance. It has no built-in UI: you drive it from attributes, a JSON file or JavaScript, and build whatever controls you need on top using its methods and events.

It's not trying to be a gallery. It's the viewport part of one, so it fits into slideshows, hero banners, lightboxes, kiosks and other media apps.

- About 9 KB minified, under 4 KB gzipped.
- Accessible by default: real `<img>` elements with alt text, carousel semantics, and announcements when someone navigates. Auto-advance holds on focus (and optionally hover), and reduced-motion preferences are respected.
- Careful with resources:
  - Nothing loads until the panel is near the viewport.
  - Rotation stops while the tab is hidden.
  - The next image is preloaded and decoded before it's shown.
  - `srcset` is supported, and `sizes` defaults to the panel's rendered width.
- Each slide can be fitted, positioned, flipped, transformed and clipped.

## Usage

Add the script once, as either a classic script or a module:

```html
<script src="dist/image-panel.js"></script>
<!-- or -->
<script type="module" src="dist/image-panel.esm.js"></script>
```

```js
import 'image-panel';            // registers <image-panel>
import {ImagePanel} from 'image-panel';
```

Then give it slides in one of three ways.

**1. Child images.** These work without any config, and the first image still shows if the script fails to load.

```html
<image-panel autoplay aria-label="Recent work">
    <img src="one.jpg" alt="…">
    <img src="two.jpg" alt="…" loading="lazy" data-position="center 30%">
    <img src="three.jpg" alt="…" loading="lazy" data-flip="horizontal">
</image-panel>
```

Add `loading="lazy"` to every image after the first. Child images are never rendered once the component is defined, so lazy ones are only fetched when the panel actually shows them. To avoid a flash of every image before the script runs, add:

```css
image-panel:not(:defined) > img:not(:first-child) { display: none; }
```

**2. A JSON file**, so you can update the slideshow without republishing the page:

```html
<image-panel src="slideshow.json"></image-panel>
```

**3. JavaScript:**

```js
panel.config = {interval: 4000, slides: [{src: 'one.jpg', alt: '…'}, 'two.jpg']};
// or just an array of slides
panel.config = ['one.jpg', 'two.jpg'];
```

By default the panel fills its container (`height: 100%`), so the container needs a height. Otherwise, size the panel directly:

```css
image-panel { aspect-ratio: 16 / 9; height: auto; }
```

## Config

The JSON file and the `config` property share the same shape. Every top-level setting is optional, and attributes take priority over config values.

```json
{
    "basePath": "images/",
    "autoplay": true,
    "interval": 6000,
    "transitionDuration": 1000,
    "shuffle": false,
    "startIndex": 0,
    "fit": "cover",
    "position": "center",
    "sizes": "100vw",
    "slides": [
        {"src": "boat.jpg", "alt": "A woman selling goods from a small boat", "title": "Hạ Long Bay"}
    ]
}
```

| Setting | Attribute | Default | |
| --- | --- | --- | --- |
| `basePath` | | | Prefix for slide URLs. Relative paths resolve against the JSON file's URL, or the page for inline config. |
| `autoplay` | `autoplay` | off | Start advancing automatically. |
| `interval` | `interval` | `6000` | Milliseconds each slide is shown for, after its transition finishes. |
| `transitionDuration` | `transition-duration` | `1000` | Cross-fade length in ms. `0` for a hard cut. Always `0` when the user prefers reduced motion. |
| `shuffle` | `shuffle` | off | Shuffle the slides when loaded. |
| `startIndex` | `start-index` | `0` | First slide to show. |
| `fit` | `fit` | `cover` | Default `object-fit` for slides. |
| `position` | `position` | `center` | Default `object-position` for slides. |
| `sizes` | `sizes` | panel width | Default `sizes` for slides with a `srcset`. |
| | `keyboard` | off | Arrow keys, Home and End navigate. Makes the panel focusable. |
| | `pause-on-hover` | off | Hold auto-advance while the pointer is over the panel. |
| | `src` | | URL of a JSON config. |

### Slides

A slide can be a plain URL string, or an object with these fields. Child images use `data-*` attributes for the same fields: `data-fit`, `data-flip` and so on.

| Field | | |
| --- | --- | --- |
| `src` | required | Image URL. |
| `srcset`, `sizes` | | Responsive image candidates, as on `<img>`. |
| `alt` | | Alt text. Falls back to `title`. Use `""` for purely decorative images. |
| `title`, `description` | | Not displayed. Passed back in events for your own captions. |
| `fit` | `cover` | `object-fit`: `cover`, `contain`, `fill`, `none` or `scale-down`. |
| `position` | `center` | `object-position`, e.g. `"left 20%"`. Moves the image within the panel. |
| `flip` | | `horizontal`, `vertical` or `both`. |
| `transform` | | Any CSS transform, e.g. `"scale(1.2) rotate(-4deg)"`. Applied before `flip`. |
| `clip` | | Any CSS `clip-path`, e.g. `"inset(5% round 8px)"`. |
| `style` | | Raw inline CSS for the `<img>`, for anything else. The fields above take priority. |

Any other fields you add are kept and passed back to you in events.

## JavaScript API

| | |
| --- | --- |
| `play()`, `pause()` | Start or stop auto-advancing. |
| `next()`, `prev()` | Move one slide, wrapping round. Repeated calls queue up rather than waiting for each image. |
| `goTo(index)` | Show a specific slide. |
| `currentIndex`, `currentSlide` | The slide on screen (`-1`/`null` before the first one). |
| `length`, `slides` | Number of slides, and a copy of the slide list. |
| `playing` | Whether auto-advance is on. It stays `true` while temporarily held by hover, focus or a hidden tab. |
| `config` | Set to load slides and settings. Reading it returns the last config applied. |

Each attribute also has a matching property: `src`, `interval`, `transitionDuration`, `autoplay`, `shuffle`, `startIndex`, `fit`, `position`, `sizes`, `keyboard`, `pauseOnHover`.

### Events

| Event | `detail` | |
| --- | --- | --- |
| `ready` | `{length}` | Slides loaded (from any source). |
| `slidechange` | `{index, previousIndex, slide}` | A new slide has started to show. |
| `slideerror` | `{index, slide}` | An image failed to load. It's skipped from then on. |
| `error` | `{error}` | The config failed to load, or none of the images could. |
| `play`, `pause` | | Playback state changed. |

A minimal set of controls:

```js
panel.addEventListener('slidechange', ({detail}) => caption.textContent = detail.slide.title ?? '');
playButton.addEventListener('click', () => panel.playing ? panel.pause() : panel.play());
```

See [demo/index.html](demo/index.html) for a fuller example.

## Styling

The component renders into an open shadow root.

- `::part(slide)` targets the wrapper that fades, and `::part(image)` the `<img>` inside it.
- `--image-panel-fit` and `--image-panel-position` set the default `object-fit` and `object-position`.

## Accessibility

- The panel is exposed as a group with the role description "carousel". Give it a name with `aria-label`. If it's purely decorative, use `aria-hidden="true"` and empty `alt`s.
- Manual slide changes are announced politely ("Slide 2 of 5: …"). Changes made by auto-advance are not, following the WAI-ARIA carousel pattern.
- Auto-advance is off unless you ask for it. When it's on, add your own pause control: WCAG 2.2.2 requires a way to stop content that moves on its own. Focusing the panel holds it, and `pause-on-hover` holds it on hover too.
- With `prefers-reduced-motion: reduce`, slides change instantly.

## Migrating from 0.3

- The file is now `dist/image-panel.js`, not `dist/ImagePanel.js`.
- `data` is now `src`, and `fade-duration` is now `transition-duration`. `width` and `height` are gone; use CSS instead.
- In the JSON: `masterPath` is now `basePath`, which now resolves relative to the JSON file. `slideInterval` is now `interval`, and `shuffleSlides` is now `shuffle`.
- The slideshow no longer starts on its own. Add `autoplay` (attribute or JSON).
- Slides are `<img>` elements now, not background images, so `background-*` styles no longer apply:
  - `background-position: X` becomes `"position": "X"`.
  - `background-size: contain` becomes `"fit": "contain"`.
  - `transform: scaleX(-1)` becomes `"flip": "horizontal"`, although a raw `transform` in `style` still works.

## Development

```sh
npm install
npm start          # build, watch and serve the demo at http://localhost:8000/demo/
npm run build      # build dist/
npx playwright install chromium firefox   # once
npm test
```

## Licence

[MPL-2.0](LICENSE)
