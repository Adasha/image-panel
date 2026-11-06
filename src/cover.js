/**
 * The maths behind `fill-panel`: zooming an image, or the motion it's in, just enough to keep covering its box.
 */

const covers = new WeakMap(); // image -> its transform as set, and as last covered

/**
 * Makes an attached image cover its box: no letterboxing, and no transform that leaves gaps.
 * Can be run again, as the box changes, without stacking zoom on zoom.
 */
export function coverPanel(img)
{
    if (!['cover', 'fill'].includes(getComputedStyle(img).objectFit))
    {
        img.style.objectFit = 'cover';
    }
    // Start again from the transform as set, unless something else has changed it since
    const last = covers.get(img);
    const raw = last && img.style.transform === last.covered ? last.raw : img.style.transform;
    if (raw) img.style.transform = covering(img, raw);
    covers.set(img, {raw, covered: img.style.transform});
}

/**
 * The transform, with extra zoom if needed so the attached element still covers its own untransformed box.
 * Zooming in on top of any pan or rotation keeps the composition, just closer. The zoom is about the
 * box's centre wherever the transform pivots, since zooming about a corner could never cover the far side.
 */
function covering(el, transform)
{
    const box = measure(el);
    if (!box.width || !box.height || !transform || transform === 'none') return transform;

    // Let the browser resolve percentages and units into a matrix
    const previous = el.style.transform;
    el.style.transform = transform;
    const zoom = coverZoom(getComputedStyle(el).transform, box);
    el.style.transform = previous;

    // A transform that collapses the element, or turns it away, can't be rescued
    if (!Number.isFinite(zoom)) return 'none';
    if (zoom <= 1.0001) return transform;
    const scale = `scale(${zoom.toFixed(4)})`;
    // The zoom comes after the transform, so it's about the transform origin unless moved to the centre
    const [dx, dy] = fromOrigin(box);
    return dx || dy
        ? `${transform} translate(${dx}px, ${dy}px) ${scale} translate(${-dx}px, ${-dy}px)`
        : `${transform} ${scale}`;
}

const NO_ZOOM = [{scale: '1'}, {scale: '1'}];

/**
 * Zoom keyframes for the slide's image that keep the slide's motion covering the panel at every moment,
 * not just at its keyframes. The browser blends rotation and zoom in straight lines, but the zoom a
 * rotation needs is a curve, so the motion is sampled finely along its length instead. The keyframes
 * are spaced in the same eased progress as the motion's, so given the same timing the two stay in step.
 */
export function motionCoverZoom(frame, img, keyframes)
{
    const box = measure(frame);
    if (!box.width || !box.height) return NO_ZOOM;

    // Seek a paused copy of the motion and let the browser do the blending, so spins, mismatched
    // function lists and percentages all come out exactly as they will play
    const steps = 12 * (keyframes.length - 1);
    const probe = frame.animate(keyframes, {duration: steps, fill: 'both'});
    probe.pause();
    const needs = [];
    for (let step = 0; step <= steps; step++)
    {
        probe.currentTime = step;
        // A frame that can't be covered (collapsed, or turned away) keeps a usable value rather than infinite
        needs.push(Math.min(coverZoom(getComputedStyle(frame).transform, box), 100));
    }
    probe.cancel();
    if (needs.every(need => need <= 1.0001)) return NO_ZOOM;

    // `scale` zooms about the image's transform origin: a matching `translate` moves that to its centre
    const [dx, dy] = fromOrigin(measure(img));
    // Between samples the zoom is blended in a straight line too, so each takes its neighbours' need as
    // well, plus a little margin for the curve between them
    return needs.map((need, step) => {
        const zoom = Math.max(need, needs[step - 1] ?? 1, needs[step + 1] ?? 1) * 1.005;
        const frame = {scale: zoom.toFixed(4), offset: step / steps};
        if (dx || dy) frame.translate = `${(1 - zoom) * dx}px ${(1 - zoom) * dy}px`;
        return frame;
    });
}

/** An element's size and transform origin, in px from its top left. */
function measure(el)
{
    const [x, y, z = 0] = getComputedStyle(el).transformOrigin.split(' ').map(parseFloat);
    return {width: el.offsetWidth, height: el.offsetHeight, origin: [x, y, z]};
}

/** How far the box's centre is from its transform origin, ignoring a fraction of a pixel. */
function fromOrigin({width, height, origin: [x, y]})
{
    const round = value => (Math.abs(value) < 0.01 ? 0 : Number(value.toFixed(2)));
    return [round(width / 2 - x), round(height / 2 - y)];
}

/**
 * The extra zoom, about the centre of the element's box, that its transform needs to still cover that box.
 * Each corner of the box is traced back through the transform to the point on the element shown there:
 * all must land inside it. A 3D or perspective transform still keeps the element flat, so on its plane
 * (z = 0) the matrix is a 3 × 3 projective map, which is inverted to do the tracing.
 */
function coverZoom(transform, {width, height, origin: [ox, oy, oz]})
{
    // The browser applies the matrix about the origin: move there, transform, and move back
    const m = new DOMMatrix(transform);
    const inverse = invert3([
        m.m11, m.m21, m.m41 - oz * m.m31,
        m.m12, m.m22, m.m42 - oz * m.m32,
        m.m14, m.m24, m.m44 - oz * m.m34,
    ]);
    if (!inverse) return Infinity;

    const [cx, cy] = [width / 2, height / 2];
    let zoom = 1;
    for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]])
    {
        const [px, py] = [x - ox, y - oy];
        const u = inverse[0] * px + inverse[1] * py + inverse[2];
        const v = inverse[3] * px + inverse[4] * py + inverse[5];
        const w = inverse[6] * px + inverse[7] * py + inverse[8];
        // The corner would need a point behind the viewer: the element is turned away from it
        if (!(w > 0)) return Infinity;
        zoom = Math.max(zoom, Math.abs(u / w + ox - cx) / cx, Math.abs(v / w + oy - cy) / cy);
    }
    return Number.isNaN(zoom) ? Infinity : zoom;
}

/** The inverse of a 3 × 3 matrix, given row by row, or null if it has none. */
function invert3([a, b, c, d, e, f, g, h, i])
{
    const [A, B, C] = [e * i - f * h, f * g - d * i, d * h - e * g];
    const det = a * A + b * B + c * C;
    if (!det || !Number.isFinite(det)) return null;
    return [
        A, c * h - b * i, b * f - c * e,
        B, a * i - c * g, c * d - a * f,
        C, b * g - a * h, a * e - b * d,
    ].map(value => value / det);
}

/** The easing with any overshoot removed: `cubic-bezier()` and `linear()` outputs clamped to 0–1. */
export function clampEasing(easing)
{
    const clamp = value => Math.min(1, Math.max(0, value));
    return easing
        .replace(/cubic-bezier\(([^)]*)\)/g, (match, args) => {
            const [x1, y1, x2, y2] = args.split(',').map(Number);
            return `cubic-bezier(${x1}, ${clamp(y1)}, ${x2}, ${clamp(y2)})`;
        })
        // Each stop is an output number and up to two percentages, in either order
        .replace(/linear\(([^)]*)\)/g, (match, args) => `linear(${args
            .split(',')
            .map(stop => stop.trim().split(/\s+/).map(part => (part === '' || Number.isNaN(Number(part)) ? part : clamp(Number(part)))).join(' '))
            .join(', ')})`);
}
