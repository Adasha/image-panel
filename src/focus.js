/**
 * Focal points: the part of an image that matters, kept in view when it's cropped and moved.
 */

const X_EDGES = {left: 0, right: 1};
const Y_EDGES = {top: 0, bottom: 1};
const CENTRE = {from: 0, pct: 0.5, px: 0};

/**
 * Reads a position written like CSS `background-position` into a horizontal and a vertical part, each
 * measured `from` the start (0) or end (1) edge as a fraction of the slack plus any pixels, or null.
 * One or two values (`center`, `25% 40%`, `left top`, `left 30%`), or edges with offsets
 * (`left 30% top 20%`, `right 10% bottom`).
 */
function parsePosition(value, lengths)
{
    const tokens = String(value).trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 4) return null;
    const length = token => {
        const match = token.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|px)?$/);
        if (!match || (match[2] !== '%' && !(lengths && match[2] === 'px') && Number(match[1]) !== 0)) return null;
        return match[2] === '%' ? {from: 0, pct: match[1] / 100, px: 0} : {from: 0, pct: 0, px: Number(match[1])};
    };
    const edge = (word, offset = {pct: 0, px: 0}) => ({...offset, from: X_EDGES[word] ?? Y_EDGES[word] ?? 0});
    const isX = word => word in X_EDGES, isY = word => word in Y_EDGES, isKeyword = word => isX(word) || isY(word) || word === 'center';

    if (tokens.length <= 2)
    {
        let [a, b = 'center'] = tokens;
        // A vertical keyword first, or a horizontal one second, means they're written the other way round
        if (isY(a) || isX(b))
        {
            if (!isKeyword(a) || !isKeyword(b)) return null;
            [a, b] = [b, a];
        }
        const part = (token, fits) => token === 'center' ? CENTRE : fits(token) ? edge(token) : length(token);
        const x = part(a, isX), y = part(b, isY);
        return x && y && !isY(a) && !isX(b) ? [x, y] : null;
    }

    // Three or four values: each edge keyword takes an optional offset after it
    const groups = [];
    for (const token of tokens)
    {
        if (isKeyword(token)) groups.push({word: token});
        else if (groups.length && !groups.at(-1).offset && groups.at(-1).word !== 'center' && length(token)) groups.at(-1).offset = length(token);
        else return null;
    }
    if (groups.length !== 2) return null;
    let [first, second] = groups;
    if (isY(first.word) || isX(second.word)) [first, second] = [second, first];
    if (isY(first.word) || isX(second.word)) return null;
    const part = ({word, offset}) => word === 'center' ? CENTRE : edge(word, offset);
    return [part(first), part(second)];
}

/**
 * A focal point as [x, y] fractions of the image, or null if it isn't one. Lengths aren't accepted,
 * since with `srcset` the image's natural size depends on which candidate loaded.
 */
export function parseFocalPoint(value)
{
    const parts = parsePosition(value, false);
    return parts && parts.map(({from, pct}) => from ? 1 - pct : pct);
}

/** A focal range as [x, y] fractions, 0 to 1, from one or two percentages, or null if it isn't one. */
export function parseFocalRange(value)
{
    const parts = String(value).trim().split(/\s+/);
    if (parts.length > 2 || !parts.every(part => /^(\d+\.?\d*|\.\d+)%$/.test(part))) return null;
    const [x, y = x] = parts.map(part => Math.min(1, parseFloat(part) / 100));
    return [x, y];
}

const positions = new WeakMap(); // image -> its object-position as set, and as last placed

/**
 * Crops an attached image about its focal point on any axis where it overflows its box, keeping the
 * point as central as the image allows. Letterboxed axes keep their `object-position`. Can be run again
 * as the box changes. `mirror` is [horizontal, vertical] for a flipped image.
 * Returns where the point is in the box, as [x, y] fractions of it, or null if it can't be measured yet.
 */
export function placeFocalPoint(img, [fx, fy], mirror = [false, false])
{
    // Start again from the position as set, unless something else has changed it since
    const last = positions.get(img);
    const raw = last && img.style.objectPosition === last.placed ? last.raw : img.style.objectPosition;
    img.style.objectPosition = raw;
    positions.set(img, {raw, placed: raw});

    const [width, height, naturalWidth, naturalHeight] = [img.offsetWidth, img.offsetHeight, img.naturalWidth, img.naturalHeight];
    if (!width || !height || !naturalWidth || !naturalHeight) return null;

    const style = getComputedStyle(img);
    const [w, h] = renderedSize(style.objectFit, width, height, naturalWidth, naturalHeight);
    // The position as set aligns letterboxed axes. Anything this can't read, such as calc(), counts as centred
    const [ax, ay] = parsePosition(style.objectPosition, true) ?? [CENTRE, CENTRE];
    const place = (box, size, f, align) => {
        const slack = box - size;
        if (slack < -0.5) return {offset: Math.min(0, Math.max(slack, box / 2 - f * size)), cropped: true};
        const shift = align.pct * slack + align.px;
        return {offset: align.from ? slack - shift : shift, cropped: false};
    };
    const x = place(width, w, fx, ax);
    const y = place(height, h, fy, ay);
    if (x.cropped || y.cropped)
    {
        img.style.objectPosition = `${round(x.offset)}px ${round(y.offset)}px`;
        positions.set(img, {raw, placed: img.style.objectPosition});
    }
    const px = (x.offset + fx * w) / width;
    const py = (y.offset + fy * h) / height;
    return [mirror[0] ? 1 - px : px, mirror[1] ? 1 - py : py];
}

/** The size an image is drawn at in its box, for each `object-fit`. */
function renderedSize(fit, width, height, naturalWidth, naturalHeight)
{
    const contain = Math.min(width / naturalWidth, height / naturalHeight);
    const scale = {
        contain,
        cover: Math.max(width / naturalWidth, height / naturalHeight),
        none: 1,
        'scale-down': Math.min(1, contain),
    }[fit];
    return scale === undefined ? [width, height] : [naturalWidth * scale, naturalHeight * scale];
}

const round = value => Number(value.toFixed(2));

/**
 * A gentle zoom in or out about a focal point, at `point` in the box (fractions), as `translate() scale()`
 * keyframes for a frame whose transform origin is that point. At each keyframe the point lands somewhere
 * within `range` of the centre, or as near the centre as the frame can get while still covering the box.
 */
export function focalMotion(point, range, scales)
{
    return scales.map(scale => {
        const offsets = point.map((p, axis) => {
            // Where the point can land with the frame still covering the box, less a small margin
            const margin = (scale - 1) * 0.05;
            const low = scale * p - (scale - 1) + margin;
            const high = scale * p - margin;
            const [near, far] = [0.5 - range[axis] / 2, 0.5 + range[axis] / 2];
            const [from, to] = [Math.max(low, near), Math.min(high, far)];
            const land = from <= to ? from + Math.random() * (to - from) : Math.min(high, Math.max(low, 0.5));
            return ((land - p) * 100).toFixed(2);
        });
        return {transform: `translate(${offsets[0]}%, ${offsets[1]}%) scale(${scale.toFixed(3)})`};
    });
}
