# image-panel

A small, dependency-free image viewer web component. It shows one image at a time, cross-fades between them, and can auto-advance. It has no built-in UI: you drive it from attributes, a JSON file or JavaScript, and build whatever controls you need on top using its methods and events.

It's not trying to be a gallery. It's the viewport part of one, so it fits into slideshows, hero banners, lightboxes, kiosks and other media apps.

- About 16 KB minified, around 6.5 KB gzipped.
- Accessible by default: real `<img>` elements with alt text and carousel semantics. Auto-advance holds on focus (and optionally hover), and reduced-motion preferences are respected.
- Careful with resources:
  - Nothing loads until the panel is near the viewport.
  - Rotation stops while the tab is hidden.
  - The next image is preloaded and decoded before it's shown.
  - `srcset` is supported, and `sizes` defaults to the panel's rendered width.
- Each slide can be fitted, positioned, flipped, transformed and clipped.
- Titles, captions, alt text and credits can be read from the image files' own [metadata](#metadata).

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
    "loop": true,
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
| `loop` | `loop` | on | Wrap round from the last slide to the first, and back. Set `loop="false"` to stop at the ends: autoplay then pauses on the last slide. |
| `startIndex` | `start-index` | `0` | First slide to show. |
| `fit` | `fit` | `cover` | Default `object-fit` for slides. |
| `position` | `position` | `center` | Default `object-position` for slides. |
| `sizes` | `sizes` | panel width | Default `sizes` for slides with a `srcset`. |
| `metadata` | `metadata` | off | Fill in missing slide fields from each image's [metadata](#metadata). |
| `motion` | `motion` | none | Default [motion](#motion) for slides without their own: `"random"`, `"none"`, or a motion spec (config and JS only). |
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
| `creator`, `copyright` | | Not displayed. Passed back in events for your own credits. |
| `fit` | `cover` | `object-fit`: `cover`, `contain`, `fill`, `none` or `scale-down`. |
| `position` | `center` | `object-position`, e.g. `"left 20%"`. Moves the image within the panel. |
| `flip` | | `horizontal`, `vertical` or `both`. |
| `transform` | | Any CSS transform, e.g. `"scale(1.2) rotate(-4deg)"`. Applied before `flip`. |
| `clip` | | Any CSS `clip-path`, e.g. `"inset(5% round 8px)"`. |
| `motion` | | A slow pan or zoom over the slide's time on screen: `"random"` or a motion spec. See [Motion](#motion). `false` or `"none"` turns off a panel-wide default. |
| `style` | | Raw inline CSS for the `<img>`, for anything else. The fields above take priority. |

Any other fields you add are kept and passed back to you in events.

### Motion

`motion` moves a slide while it's on screen. It's a list of CSS transforms, spread evenly from the moment the slide starts fading in to the moment it finishes fading out (`transitionDuration + interval + transitionDuration`):

```json
{"src": "boat.jpg", "motion": ["scale(1.15) translate(-3%, 2%)", "scale(1)"]}
```

Or an object, to add an easing (default `linear`):

```json
{"src": "boat.jpg", "motion": {"from": "scale(1)", "to": "scale(1.2) translate(4%, 0)", "easing": "ease-in-out"}}
```

`{"keyframes": [...], "easing": "..."}` takes a list in the same way.

`"random"` picks a gentle zoom in or out between two random points, fresh each time the slide shows, and never far enough to reveal the panel edges.

A panel-wide default applies to every slide without its own `motion`, and `"motion": false` (or `"none"`) on a slide keeps it still. Set the default any of these ways, highest priority first:

```js
panel.motion = {from: 'scale(1)', to: 'scale(1.1)'};  // any spec, from JavaScript
panel.motion = 'random';                               // strings are reflected to the attribute
```
```html
<image-panel motion="random"></image-panel>
```
```json
{"motion": "random", "slides": ["…"]}
```

Changing it affects the next slide shown, not the current one. Set `panel.motion = null` to fall back to the config.

- The transforms apply to the slide wrapper (`::part(slide)`), in panel coordinates, so they combine with the image's own `transform` and `flip` rather than replacing them. Translating by a percentage moves by that much of the panel.
- Zoom in rather than out (scale ≥ 1 throughout), or the panel background shows at the edges.
- Motion only runs while the panel is playing: it freezes with `pause()` and whenever auto-advance is held (focus, hover, hidden or offscreen), and it holds on its last frame if the slide outlives it. Without `autoplay`, slides stay still.
- It's turned off entirely when the user prefers reduced motion.

### Metadata

With `metadata` on, the panel reads each image's embedded metadata as the slide first loads, and uses it to fill in the fields the slide doesn't set itself. Anything you set in the JSON, config or `data-*` attributes wins, including `alt=""`.

```html
<image-panel src="slideshow.json" metadata></image-panel>
```

| Field | Read from, in order |
| --- | --- |
| `title` | XMP `dc:title`, IPTC Object Name, XMP `photoshop:Headline`, IPTC Headline |
| `description` | XMP `dc:description`, IPTC Caption/Abstract, EXIF ImageDescription |
| `alt` | XMP `Iptc4xmpCore:AltTextAccessibility` (the IPTC alt text field), then falls back to `title` as usual |
| `creator` | XMP `dc:creator`, IPTC By-line, EXIF Artist |
| `copyright` | XMP `dc:rights`, IPTC Copyright Notice, EXIF Copyright |

These are the fields Lightroom, Photoshop, Bridge and most photo managers write.

- JPEG and PNG files are supported.
- Where a field has several languages, the one matching the panel's `lang` is used, falling back to the default.
- Camera placeholders such as "OLYMPUS DIGITAL CAMERA" are ignored.
- Only the file's header is downloaded, up to where the image data starts. This is usually a few tens of KB, in parallel with the image itself. It's a separate request, though, so it's off by default.
- Images on another origin need CORS headers (`Access-Control-Allow-Origin`) for their metadata to be read. Without them, the slide still shows, just without the extra fields, and a warning is logged.
- Metadata is read from `src`, not from `srcset` candidates, since resized copies often have their metadata stripped.
- Fields are filled in by the time `slideload` and `slidechange` fire for that slide. Slides that haven't loaded yet don't have them, and before the first load their `alt` isn't set yet either.

## JavaScript API

| | |
| --- | --- |
| `motion` | Default slide motion. See [Motion](#motion). |
| `play()`, `pause()` | Start or stop auto-advancing. Without `loop`, `play()` on the last slide starts over from the first. |
| `next()`, `prev()` | Move one slide, wrapping round if `loop` is on. Repeated calls queue up rather than waiting for each image. |
| `goTo(index)` | Show a specific slide. Out-of-range indexes wrap if `loop` is on, and are ignored otherwise. |
| `currentIndex`, `currentSlide` | The slide on screen (`-1`/`null` before the first one). |
| `length`, `slides` | Number of slides, and a copy of the slide list. |
| `playing` | Whether auto-advance is on. It stays `true` while temporarily held by hover, focus or a hidden tab. |
| `config` | Set to load slides and settings. Reading it returns the last config applied. |

Each attribute also has a matching property: `src`, `interval`, `transitionDuration`, `autoplay`, `shuffle`, `loop`, `startIndex`, `fit`, `position`, `sizes`, `metadata`, `keyboard`, `pauseOnHover`. `metadata` applies the next time slides load.

### Events

All events are `CustomEvent`s dispatched on the panel. They don't bubble.

Every event's `detail` includes a `trigger` saying what caused it:

| `trigger` | Cause |
| --- | --- |
| `'start'` | The panel starting up: the first slide shown after slides load, and `autoplay` starting playback. |
| `'auto'` | The panel acting on its own: auto-advance, preloading the next slide, and playback ending. |
| `'keyboard'` | Arrow keys, Home or End. |
| `'api'` | Your code: methods like `next()` or `play()`, and setting `src`, `config`, `interval` or child images. |
| `'focus'`, `'hover'`, `'hidden'`, `'offscreen'` | A hold starting or ending: focus in the panel, hover with `pause-on-hover`, the tab being hidden, or the panel scrolling out of view. |

Events that follow from an earlier action keep its trigger. For example, after pressing →, the image load, `slidechange` and the restarted `countdown` all report `'keyboard'`. The tables below list each event's other `detail` fields.

**Loading**

| Event | `detail` | |
| --- | --- | --- |
| `configloadstart` | `{url}` | Started fetching the `src` JSON. |
| `ready` | `{length}` | Slides are known (from any source) and about to start showing. |
| `error` | `{error}` | The config failed to load, or none of the images could. |
| `slideloadstart` | `{index, slide, preload}` | An image started loading. `preload` is true for the background preload of the next slide. |
| `slideload` | `{index, slide}` | An image loaded and decoded. |
| `slideerror` | `{index, slide}` | An image failed to load. It's skipped from then on. |

**Navigation**, in the order they fire:

| Event | `detail` | |
| --- | --- | --- |
| `navigate` | `{index, previousIndex}` | Heading for a new slide, before its image is ready. `index` can change if that image fails. |
| `loop` | `{index, previousIndex}` | The change wrapped round from one end to the other. |
| `slidechange` | `{index, previousIndex, slide}` | The new slide is starting to show. `currentIndex` is already updated. |
| `slidechangeend` | as `slidechange` | The new slide has finished transitioning in (straight away with reduced motion or `transition-duration="0"`). Not fired if another slide interrupts the transition. |

**Playback**

| Event | `detail` | |
| --- | --- | --- |
| `play` | | Auto-advance turned on. |
| `pause` | | Auto-advance turned off, by `pause()` or by reaching the end. |
| `ended` | | Auto-advance reached the last slide without `loop`. Follows `pause`. |
| `hold` | | Auto-advance is held while still playing. `trigger` gives the cause. |
| `resume` | | The last hold was released and auto-advance carries on. `trigger` is the hold that was released last. |
| `countdown` | `{remaining, interval}` | The timer to the next slide started, or resumed with `remaining` ms left. Useful for progress indicators. |

A minimal set of controls:

```js
panel.addEventListener('slidechange', ({detail}) => caption.textContent = detail.slide.title ?? '');
playButton.addEventListener('click', () => panel.playing ? panel.pause() : panel.play());
```

See [demo/index.html](demo/index.html) for a fuller example.

## Styling

The component renders into an open shadow root.

- `::part(slide)` targets the wrapper that fades and carries any `motion`, and `::part(image)` the `<img>` inside it.
- `--image-panel-fit` and `--image-panel-position` set the default `object-fit` and `object-position`.

## Accessibility

- The panel is exposed as a group with the role description "carousel". Give it a name with `aria-label`. If it's purely decorative, use `aria-hidden="true"` and empty `alt`s.
- Nothing is announced to screen readers, since any wording or counter is UI and yours to choose. To announce slide changes, use a polite live region of your own and update it from `slidechange`. Skip changes that auto-advance or the initial load caused, following the WAI-ARIA carousel pattern:

  ```js
  panel.addEventListener('slidechange', ({detail}) => {
      if (detail.trigger === 'auto' || detail.trigger === 'start') return;
      status.textContent = `Slide ${detail.index + 1} of ${panel.length}`;
  });
  ```
- Auto-advance is off unless you ask for it. When it's on, add your own pause control: WCAG 2.2.2 requires a way to stop content that moves on its own. Focusing the panel holds it, and `pause-on-hover` holds it on hover too.
- With `prefers-reduced-motion: reduce`, slides change instantly and `motion` is ignored.
- `motion` stops whenever auto-advance does, so the same pause control covers both.

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
