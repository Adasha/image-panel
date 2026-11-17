# Roadmap

Where image-panel is heading on the way to 1.0, and what might come after. The scope stays the same: a small, dependency-free viewport with no built-in UI. Controls, captions, thumbnails and galleries belong to whatever is built on top of it.

Versions are targets, not promises. Anything that changes the shape of the API (slide fields, config semantics, events) goes before 1.0. Purely additive features can land in 1.x. Released changes are recorded in [CHANGELOG.md](CHANGELOG.md).

| Version | Theme | Items |
| --- | --- | --- |
| **0.8** | The rewrite | Released. See the [changelog](CHANGELOG.md#080---2026-11-14). |
| **0.9** | Input and focus | [Swipe](#swipe), [focal point](#focal-point). Also: works under a strict CSP. |
| **0.10** | Slides, long-running displays and loading | [Per-slide interval](#per-slide-interval), [format sources](#format-sources), [reloading the config](#reloading-the-config), [placeholders](#placeholders), [Save-Data](#save-data) |
| **1.0** | Stable API | [API review and freeze](#10-api-review-and-freeze) |
| **1.x** | Additive | [Custom transitions](#custom-transitions), [clock sync](#clock-sync), [focus area](#focus-area), [points of interest](#points-of-interest), [video slides](#video-slides) (undecided) |

---

## 0.9: Input and focus

### Swipe

**Status:** first version done, unreleased (see the changelog). Follow-the-finger dragging is still open.

Navigate with touch, pen and mouse drags, like the arrow keys do with `keyboard`. It's the biggest gap for the website on phones, and it's input, not UI, so it fits the component.

- `swipe` attribute and `swipe` property, off by default like `keyboard`. Events report `trigger: 'swipe'`.
- First version: a horizontal swipe past a distance or speed threshold calls `next()` / `prev()`, mirrored in right-to-left layouts. `touch-action: pan-y` keeps vertical page scrolling working. Pointer capture, and a click that ends a drag is suppressed.
- Later, maybe: the slide follows the finger during the drag, then completes or snaps back. That's harder with Web Animations transitions, so it's left out of the first version.
- Holds auto-advance during the drag, as a `'swipe'` hold. Moving to a slide restarts the countdown as other input does.
- **Done when:** works with touch, pen and mouse in Chromium and Firefox (Playwright touch emulation), doesn't block page scrolling, and respects `loop="false"` at the ends.

### Focal point

Mark the part of an image that matters, so cropping, zooming and panning never lose it. Without it, `motion: "random"` can drift off a face, and a narrow panel can crop the subject out.

**Status:** done, unreleased (see the changelog). Giving the point a size is the [focus area](#focus-area), in 1.x.

- `focalPoint` slide field (`data-focal-point` on child images), plus a panel-wide `focal-point` attribute and `focalPoint` property as the default, like `position`. (Not `focus`: a `focus` property would shadow `HTMLElement.focus()`.) `"none"` on a slide turns off a panel-wide default.
- Written like a CSS `background-position`: keywords and percentages, with offsets (`left 30% top 20%`, `25% 40%`, `center`). It names a point in the image, so `25% 40%` is a quarter of the way across and 40% of the way down. A keyword puts the point on that edge (`left` is the left edge), and an offset is measured in from it. Lengths aren't accepted for now: with `srcset` the natural size depends on the candidate loaded. They could come back with a slide width/height field.
- Placement: the panel keeps the focal point as close to its centre as the image allows. The image never pulls away from the panel edge to do it, so a point near the image edge ends up near the panel edge, and a point on it (`left`) can sit right at the edge.
- Range: `focal-range` attribute, `focalRange` property and `focalRange` slide field (`data-focal-range`) set how far the point may stray from centre, as a percentage of the distance from the centre to the panel edge: `0%` (the default) is as central as possible, `100%` is anywhere in frame. One value sets both axes, two set horizontal then vertical (`40% 10%`). It gives `random` motion room to move.
- Cropping: on any axis where the image is bigger than the panel (`cover`, and `none` or `scale-down` with a large image), the crop is set by the focal point rather than by `position`. `position` still aligns letterboxed axes, and sets the crop when there's no focal point.
- Motion: the motion wrapper's transform origin defaults to the focal point, so motion zooms about it. Object motion specs take an optional `origin` (`{from, to, origin: "center"}`) to set their own, and `::part(motion) { transform-origin }` still wins. `random` keeps the focal point within the range at every keyframe. Explicit specs are otherwise left as written.
- Precedence: `fill-panel` comes first. If the zoom it needs to keep the panel covered pushes the focal point off-centre, or out of frame, it stays that way.
- A point says where the subject is but not how big it is. Giving it a size comes later, as a [focus area](#focus-area), and the API here should leave room for it.
- **Done when:** random motion and `fill-panel` keep the focal point in view across `fit` values and panel shapes, a cover crop centres on it, and there are tests.

---

## 0.10: Slides, long-running displays and loading

### Per-slide interval

Let a slide stay on screen for longer or shorter than the panel's `interval`, for title cards and key images.

- `interval` slide field (`data-interval` on child images). The panel's `interval` stays the default.
- `motion` timing uses the slide's interval, and `countdown` reports it.
- Changing the panel `interval` mid-slide doesn't affect a slide that sets its own.
- **Done when:** countdown, motion duration and auto-advance all use the slide's value, with tests.

### Format sources

Offer modern formats (AVIF, WebP) with a fallback, which `srcset` can't do on its own.

- `sources` slide field: `[{type: 'image/avif', srcset: '…', sizes?: '…', media?: '…'}]`, rendered as `<picture>` with `<source>` elements round the `<img>`.
- Child `<picture>` elements accepted alongside child `<img>`, with the same `data-*` fields on the `<img>`.
- `basePath` applies to `sources` srcsets as well. Preloading and decoding use whichever candidate the browser picks.
- `metadata` still reads from `src`.
- **Decision before starting:** whether `media` (art direction) is in scope, given `fit` and `position` are per slide, not per source.
- **Done when:** the browser picks the right candidate, preload and `slideload` behave as for plain images, and child `<picture>` works without the script.

### Reloading the config

A picture frame or installation never reloads the page, so changes to the JSON never appear.

- `reload()` method: re-fetches `src`, or re-reads child images.
- `refresh` attribute: re-fetch `src` every *n* ms. Conditional requests (`ETag` / `If-Modified-Since`) keep it cheap when nothing has changed.
- The new list replaces the old at the next slide change, not mid-transition. If the current slide (matched by `src`) is still in the list, playback carries on from it. Otherwise the panel moves to the next slide.
- Events: a `configload` event when new slides are applied. A failed refresh keeps the current slides and fires `error` without stopping playback.
- **Decision before starting:** whether shuffle order is re-rolled on refresh.

### Placeholders

Something to show while the first image loads, instead of the empty panel background.

- `placeholder` slide field: a CSS colour or a small image URL (a data URI or a few-pixel blurred thumbnail), shown behind the slide until it decodes, then faded out.
- Mainly helps the first slide and slow connections, since later slides are preloaded already.

### Save-Data

Respect the user's request to save data, in line with the performance goal.

- When `navigator.connection.saveData` is true: no background preload of the next slide, and no `metadata` header fetches.
- No new API, but noted in the README. Possibly a `preload` attribute later if anyone needs to control it directly.

---

## 1.0: API review and freeze

No new features. 1.0 means the API is settled and breaking changes then need 2.0.

- Review every attribute, property, slide field, event, `detail` field and `::part` for naming and consistency, and make any last breaking changes in a 0.x release first.
- Decide on [video slides](#video-slides) enough to know whether any field (such as a slide `type`) needs reserving now.
- State supported browsers in the README, and test them in CI.
- Check size: say what the budget is, and add a CI check against it.
- Publish to npm, as every release is from 0.8.0 on.

---

## 1.x: Additive

### Custom transitions

Let transitions be defined outside the built-in set, from JavaScript or straight from the config. Both routes go through the same path as the built-in types (`#animateTransition`), so per-slide transitions, `transition-duration`, `transition-easing`, reduced motion, interruptions and events all keep working.

**A transition registry (JavaScript):**

```js
ImagePanel.defineTransition('iris', ({incoming, outgoing, duration, easing, direction, color, feather}) => [
    incoming.animate({clipPath: ['circle(0%)', 'circle(75%)']}, {duration, easing}),
]);
```

- A static method that registers a function by name. The name can then be used anywhere a transition goes, including JSON and attributes, with options parsed as for the built-ins.
- The function returns its animations, and the first one must span the whole transition (the panel waits for it). Outgoing animations should use `fill: 'forwards'`.
- The built-in types are registered the same way, which replaces the current `switch`.
- Registering a built-in name replaces it. Unknown names fall back to `fade` with a warning, as now.

**Keyframes in the config:**

```json
{"transition": {"in": [{"opacity": 0, "filter": "blur(20px)"}, {"opacity": 1, "filter": "none"}],
                "out": [{"opacity": 1}, {"opacity": 0, "scale": 0.9}]}}
```

- `in` and `out` are Web Animations keyframes for the incoming and outgoing slides, using the panel's duration and easing. Either can be left out.
- Works per slide and panel-wide, and in JSON, so no script is needed. Built as a small built-in on top of the registry.
- **Decisions before starting:**
  - How to opt into the `blend` compositing that keeps cross-fades from dipping in brightness (for example `"blend": true`).
  - Whether keyframes can follow the navigation direction (for example a `{dx}`/`{dy}` placeholder in values).
- **Done when:** a registered transition and a keyframe transition both work per slide and panel-wide, respect reduced motion and interruptions, and have tests. The README documents the function contract.

Real CSS `@keyframes`, applied through `::part(entering)` / `::part(leaving)`, was considered and left out. The duration would then live in CSS, out of reach of `transitionDuration`, motion timing and the countdown.

### Clock sync

Work out the current slide from wall-clock time instead of from page load, so several screens stay in step without talking to each other, and a reloaded display rejoins at the right point.

- `sync` attribute taking an epoch (ISO date or timestamp). Slide index and remaining time come from `(now - epoch)` and the total cycle length.
- Needs fixed timing, so it ignores holds (or documents that a held screen drifts until the next slide) and works with `shuffle` only with a seeded shuffle.

### Focus area

Give the focal point a size, so the panel keeps a whole subject in view, not just its centre. Builds on the [focal point](#focal-point).

- A width and height round the focal point, as percentages of the image or natural-size pixels, for example `focalSize: "20% 25%"` (`data-focal-size`). Without one, the focus stays a point.
- Cropping and motion keep the whole area in frame where the panel's shape allows it. That caps how far `random` zooms in, and keeps a small or oddly shaped panel from cropping the subject's edges.
- If the area can't fit (a tall subject in a wide, short panel), it's kept centred on the focal point and cropped evenly.
- `fill-panel` still takes precedence, as for the point.
- **Decisions before starting:**
  - A separate field (such as `focalSize`), or one `focalPoint` value that takes an optional size.
  - Whether leniency then applies to the area's edges rather than its centre.

### Points of interest

Guide `random` motion between chosen points in the image, instead of picking them at random. Builds on the [focal point](#focal-point).

- `points` slide field: a list of positions, written the same way as `focalPoint`.
- With a focal point, a pan runs between it and one of the points (either way round). Without one, it runs between two of the points.
- Optional rules on a slide to shape how the points are used, for example:
  - the pan always ends on the focal point;
  - the pan moves along one axis only;
  - zoom in only.
- **Needs planning:** how rules are named and combined, whether they live in the slide field or a separate one, and what happens when a rule can't be met (such as one-axis motion between points that differ on both).

### Video slides

**Undecided.** Short clips in picture frames and installations would reuse the existing transitions, holds and events, but it adds weight and drifts toward a general media player. Decide whether it's in scope before 1.0. If it is, a slide likely needs a `type` (or a type inferred from the file), the clip's length could set its interval, and autoplay rules mean it has to be muted.
