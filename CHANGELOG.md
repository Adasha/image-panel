# Changelog

All notable changes to image-panel are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0, a minor version (0.x.0) may include breaking changes, which are always listed under **Changed** or **Removed** with a migration note.

## [Unreleased]

## [0.9.0] - 2026-11-17

### Added

- `swipe` attribute and property: dragging sideways with touch, pen or mouse navigates, mirrored in right-to-left layouts, without blocking vertical page scrolling. Navigation reports `trigger: 'swipe'`, and auto-advance is held during a drag as a `'swipe'` hold.
- `focalPoint` slide field (`data-focal-point`) and panel-wide `focal-point` attribute and property: the part of the image that matters, written like `background-position` with keywords and percentages. Crops on overflowing axes centre on it as far as the image allows, motion pivots on it, and `random` motion zooms about it.
- `focalRange` slide field (`data-focal-range`) and panel-wide `focal-range` attribute and property: how far `random` motion may take the focal point from the panel centre, as one or two percentages.
- An optional `origin` in object motion specs, to set the motion's transform origin.
- A JSON Schema for the config, at `schema/image-panel.schema.json` (`image-panel/schema.json` from npm), with `x-attribute`, `x-inherits` and `x-attributeOnly` annotations for authoring tools.
- `image-panel/authoring` entry point exporting the internal focal point, fill-panel and metadata helpers, for tools that preview slideshows.

### Changed

- The shadow root's styles are now a constructable stylesheet shared by every panel, rather than a `<style>` element in each. Pages with a Content Security Policy no longer need `style-src 'unsafe-inline'` for the component.

## [0.8.0] - 2026-11-14

A ground-up rewrite. Most of the API has changed: see [Migrating from 0.3](README.md#migrating-from-03).

### Added

- Slides from child `<img>` elements, a JSON file (`src`) or the `config` property, with `data-*` / JSON fields for `fit`, `position`, `flip`, `transform`, `clip`, `style`, `srcset` and `sizes`.
- Transitions: `fade`, `dip`, `wipe` (with feather), `slide`, `push` and `none`, set per panel or per slide, with `transition-duration` and `transition-easing`. Directions can be fixed, random, or follow the navigation.
- `motion`: slow pan and zoom across a slide's time on screen, from keyframes or `"random"`.
- `fill-panel`: every slide covers the panel, with extra zoom worked out for transforms and motion, and recalculated on resize.
- `metadata`: title, description, alt text, creator and copyright read from XMP, IPTC and EXIF in JPEG and PNG files.
- `loop`, `shuffle`, `start-index`, `keyboard` and `pause-on-hover`.
- JavaScript API: `play()`, `pause()`, `next()`, `prev()`, `goTo()`, `currentIndex`, `currentSlide`, `length`, `slides`, `playing`, and a property for every attribute.
- Events for loading, navigation and playback, each with a `trigger` saying what caused it.
- Carousel semantics, holding auto-advance on focus, hidden tabs and offscreen panels, and `prefers-reduced-motion` support.
- Images load only near the viewport, and the next one is preloaded and decoded before it's shown.
- `::part()` and custom properties for styling, ES module and classic script builds, a demo, a playground and Playwright tests.

### Changed

- Slides are real `<img>` elements in a shadow root, not background images.
- The build is `dist/image-panel.js` (classic) and `dist/image-panel.esm.js` (module), built with esbuild.
- `data` is now `src`, and `fade-duration` is now `transition-duration`.
- In the JSON, `masterPath` is now `basePath` (resolved against the JSON file), `slideInterval` is now `interval`, and `shuffleSlides` is now `shuffle`.
- The slideshow no longer starts on its own: add `autoplay`.

### Removed

- The `width` and `height` attributes. Size the panel with CSS.
- `background-*` slide styles. Use `position`, `fit` and `flip` instead.

## 0.3.5a and earlier

The original component, before the rewrite. These versions were not tagged.

[Unreleased]: https://github.com/Adasha/image-panel/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Adasha/image-panel/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Adasha/image-panel/releases/tag/v0.8.0
