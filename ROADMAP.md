# Roadmap

Where image-panel is heading on the way to 1.0, and what might come after. The scope stays the same: a small, dependency-free viewport with no built-in UI. Controls, captions, thumbnails and galleries belong to whatever is built on top of it.

Versions are targets, not promises. Anything that changes the shape of the API (slide fields, config semantics, events) goes before 1.0. Purely additive features can land in 1.x. Released changes are recorded in [CHANGELOG.md](CHANGELOG.md).

| Version | Theme | Items |
| --- | --- | --- |
| **0.8** | The rewrite | Released. See the [changelog](CHANGELOG.md#080---2026-11-14). |
| **0.9** | Input and slides | [Swipe](#swipe), [per-slide interval](#per-slide-interval), [format sources](#format-sources) |
| **0.10** | Long-running displays and loading | [Reloading the config](#reloading-the-config), [placeholders](#placeholders), [Save-Data](#save-data) |
| **1.0** | Stable API | [API review and freeze](#10-api-review-and-freeze) |
| **1.x** | Additive | [Custom transitions](#custom-transitions), [clock sync](#clock-sync), [focal-point motion](#focal-point-motion), [video slides](#video-slides) (undecided) |

---

## 0.9: Input and slides

### Swipe

Navigate with touch, pen and mouse drags, like the arrow keys do with `keyboard`. It's the biggest gap for the website on phones, and it's input, not UI, so it fits the component.

- `swipe` attribute and `swipe` property, off by default like `keyboard`. Events report `trigger: 'swipe'`.
- First version: a horizontal swipe past a distance or speed threshold calls `next()` / `prev()`, mirrored in right-to-left layouts. `touch-action: pan-y` keeps vertical page scrolling working. Pointer capture, and a click that ends a drag is suppressed.
- Later, maybe: the slide follows the finger during the drag, then completes or snaps back. That's harder with Web Animations transitions, so it's left out of the first version.
- Holds auto-advance during the drag, as a `'swipe'` hold. Moving to a slide restarts the countdown as other input does.
- **Done when:** works with touch, pen and mouse in Chromium and Firefox (Playwright touch emulation), doesn't block page scrolling, and respects `loop="false"` at the ends.

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

---

## 0.10: Long-running displays and loading

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

### Focal-point motion

Make `motion: "random"` keep the subject in frame by zooming toward the slide's `position`, treated as a focal point, rather than toward a random point.

- Possibly a separate `focus` slide field, if `position` and the focal point need to differ.

### Video slides

**Undecided.** Short clips in picture frames and installations would reuse the existing transitions, holds and events, but it adds weight and drifts toward a general media player. Decide whether it's in scope before 1.0. If it is, a slide likely needs a `type` (or a type inferred from the file), the clip's length could set its interval, and autoplay rules mean it has to be muted.
