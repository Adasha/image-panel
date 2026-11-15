import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {crc32, deflateSync} from 'node:zlib';

const IMAGES = ['Markermeer.jpg', 'BigPit-ChainMacro.jpg', 'holocaust_memorial.jpg'].map(name => `/demo/images/${name}`);

async function mount(page, html, {define = true} = {})
{
    await page.goto('/tests/fixture.html');
    await page.evaluate(markup => document.body.innerHTML = markup, html);
    if (define)
    {
        await page.addScriptTag({type: 'module', url: '/src/image-panel.js'});
    }
    return page.locator('image-panel').first();
}

function setConfig(panel, config)
{
    return panel.evaluate((el, value) => el.config = value, config);
}

function record(panel, ...types)
{
    return panel.evaluate((el, names) => {
        window.events = [];
        for (const type of names)
        {
            el.addEventListener(type, e => window.events.push({type, detail: e.detail && JSON.parse(JSON.stringify(e.detail))}));
        }
    }, types);
}

const events = page => page.evaluate(() => window.events);
const currentIndex = panel => panel.evaluate(el => el.currentIndex);

/**
 * Asks the browser what's at each corner of the panel, just inside it, through the newest slide's motion
 * (in `steps` even steps, or just as it stands with 0). Returns each place its image didn't cover.
 */
const uncovered = (panel, steps = 0) => panel.evaluate((el, steps) => {
    const slide = el.shadowRoot.querySelector('.slide:last-child');
    const img = slide.querySelector('img');
    const anims = slide.getAnimations({subtree: true}).filter(a => a.id.startsWith('motion'));
    const {left, top, right, bottom} = el.getBoundingClientRect();
    const misses = [];
    for (let step = 0; step <= steps; step++)
    {
        for (const anim of anims)
        {
            anim.pause();
            anim.currentTime = anim.effect.getTiming().duration * step / (steps || 1);
        }
        for (const [x, y] of [[left + 2, top + 2], [right - 2, top + 2], [left + 2, bottom - 2], [right - 2, bottom - 2]])
        {
            if (el.shadowRoot.elementFromPoint(x, y) !== img) misses.push({step, x, y});
        }
    }
    return misses;
}, steps);

/**
 * Steps through the newest slide's motion and returns how far the panel's corners fall outside the image
 * at worst, as a fraction of the panel: 0 or less means it covers throughout.
 */
const motionShortfall = panel => panel.evaluate(el => {
    const slide = el.shadowRoot.querySelector('.slide:last-child');
    const img = slide.querySelector('img');
    const anims = slide.getAnimations({subtree: true}).filter(a => a.id.startsWith('motion'));
    const {duration} = anims[0].effect.getTiming();
    const [w, h] = [slide.offsetWidth / 2, slide.offsetHeight / 2];
    let worst = 0;
    for (let i = 0; i <= 200; i++)
    {
        for (const anim of anims)
        {
            anim.pause();
            anim.currentTime = duration * i / 200;
        }
        const scale = Number(getComputedStyle(img).scale);
        const inverse = new DOMMatrix(getComputedStyle(slide.querySelector('.motion')).transform).scale(scale).inverse();
        for (const [x, y] of [[-w, -h], [w, -h], [-w, h], [w, h]])
        {
            const point = inverse.transformPoint({x, y});
            worst = Math.max(worst, Math.abs(point.x) / w - 1, Math.abs(point.y) / h - 1);
        }
    }
    return worst;
});


test.describe('loading', () => {
    test('loads a JSON config, resolving basePath against the config URL', async ({page}) => {
        const panel = await mount(page, '<image-panel src="config.json" transition-duration="0"></image-panel>');
        const img = panel.locator('img');

        await expect(img).toHaveCount(1);
        await expect(img).toHaveAttribute('src', /\/demo\/images\/Markermeer\.jpg$/);
        expect(await panel.evaluate(el => el.length)).toBe(3);
    });

    test('accepts slides as a config property, including plain strings', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect(panel.locator('img')).toHaveAttribute('src', /Markermeer\.jpg$/);
    });

    test('reads child <img> elements, with options from data attributes', async ({page}) => {
        const panel = await mount(page, `
            <image-panel transition-duration="0">
                <img src="${IMAGES[0]}" alt="Lake" data-position="left top" style="display: none">
                <img src="${IMAGES[1]}" alt="Chains">
            </image-panel>`);
        const img = panel.locator('img[part=image]');

        await expect(img).toHaveAttribute('alt', 'Lake');
        // The light DOM image's own style must not leak into the slide
        await expect(img).toBeVisible();
        await expect(img).toHaveCSS('object-position', '0% 0%');
    });

    test('picks up properties set before the element was defined', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>', {define: false});
        await setConfig(panel, IMAGES);
        await page.addScriptTag({type: 'module', url: '/src/image-panel.js'});
        await expect(panel.locator('img')).toHaveCount(1);
    });

    test('fires error for a broken config', async ({page}) => {
        const panel = await mount(page, '<image-panel></image-panel>');
        await record(panel, 'error');
        await panel.evaluate(el => el.src = 'broken.json');
        await expect.poll(() => events(page)).toHaveLength(1);
    });

    test('does not load images until the panel is near the viewport', async ({page}) => {
        const requested = [];
        page.on('request', request => request.url().endsWith('.jpg') && requested.push(request.url()));

        const panel = await mount(page, '<div style="height: 3000px"></div><image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await page.waitForTimeout(300);
        expect(requested).toHaveLength(0);

        await panel.scrollIntoViewIfNeeded();
        await expect(panel.locator('img')).toHaveCount(1);
    });

    test('uses srcset with sizes from the rendered width', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, [{src: IMAGES[0], srcset: `${IMAGES[0]} 1920w, ${IMAGES[1]} 800w`}]);
        const img = panel.locator('img');

        await expect(img).toHaveAttribute('sizes', '400px');
        await expect(img).toHaveAttribute('srcset', /^http:\/\/[^ ]+Markermeer\.jpg 1920w, http:\/\/[^ ]+ChainMacro\.jpg 800w$/);
    });
});


test.describe('slide options', () => {
    test('maps fit, position, flip, transform and clip onto the image', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, [{
            src: IMAGES[0],
            fit: 'contain',
            position: 'right 25%',
            flip: 'horizontal',
            transform: 'translateX(10px)',
            clip: 'inset(10%)',
            style: 'opacity: 0.5; object-fit: fill',
        }]);
        const img = panel.locator('img');

        await expect(img).toHaveCSS('object-fit', 'contain');
        await expect(img).toHaveCSS('object-position', '100% 25%');
        // translateX(10px) then scaleX(-1)
        await expect(img).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 10, 0)');
        await expect(img).toHaveCSS('clip-path', 'inset(10%)');
        await expect(img).toHaveCSS('opacity', '0.5');
    });

    test('motion animates the slide over its lifespan, and pause freezes it', async ({page}) => {
        const panel = await mount(page, '<image-panel autoplay interval="1000" transition-duration="500"></image-panel>');
        await setConfig(panel, [
            {src: IMAGES[0], motion: {from: 'scale(1.2)', to: 'scale(1)', easing: 'ease-in'}},
            IMAGES[1],
        ]);
        await expect(panel.locator('.slide')).toHaveCount(1);

        const motion = () => panel.evaluate(el => {
            const anim = el.shadowRoot.querySelector('.motion').getAnimations().find(a => a.id === 'motion');
            const {duration, easing} = anim.effect.getTiming();
            return {duration, easing, state: anim.playState, frames: anim.effect.getKeyframes().map(k => k.transform)};
        });
        expect(await motion()).toEqual({duration: 2000, easing: 'ease-in', state: 'running', frames: ['scale(1.2)', 'scale(1)']});

        await panel.evaluate(el => el.pause());
        expect((await motion()).state).toBe('paused');
        await panel.evaluate(el => el.play());
        expect((await motion()).state).toBe('running');
    });

    test('panel-level motion applies to slides unless they opt out', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, {motion: ['none', 'scale(1.1)'], slides: [IMAGES[0], {src: IMAGES[1], motion: false}]});

        const motions = () => panel.evaluate(el => el.shadowRoot.querySelector('.motion').getAnimations().filter(a => a.id === 'motion').length);
        await expect(panel.locator('.slide')).toHaveCount(1);
        expect(await motions()).toBe(1);
        // Not playing, so it stays put
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.motion').getAnimations()[0].playState)).toBe('paused');

        await panel.evaluate(el => el.next());
        await expect.poll(() => currentIndex(panel)).toBe(1);
        expect(await motions()).toBe(0);
    });

    test('random motion, from the attribute, config or property', async ({page}) => {
        const panel = await mount(page, '<image-panel motion="random" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect(panel.locator('.slide')).toHaveCount(1);

        const frames = () => panel.evaluate(el => el.shadowRoot.querySelector('.slide:last-child .motion').getAnimations()
            .find(a => a.id === 'motion')?.effect.getKeyframes().map(k => k.transform) ?? null);
        const random = /^translate\(-?[\d.]+%, -?[\d.]+%\) scale\(1\.\d+\)$/;
        expect(await frames()).toEqual([expect.stringMatching(random), expect.stringMatching(random)]);

        // A JS spec replaces the attribute and applies from the next slide
        await panel.evaluate(el => el.motion = ['scale(1)', 'scale(1.3)']);
        expect(await panel.evaluate(el => el.hasAttribute('motion'))).toBe(false);
        await panel.evaluate(el => el.next());
        await expect.poll(frames).toEqual(['scale(1)', 'scale(1.3)']);

        await panel.evaluate(el => el.motion = 'none');
        await panel.evaluate(el => el.next());
        await expect.poll(frames).toBe(null);

        // Clearing it falls back to the config
        await panel.evaluate(el => el.motion = null);
        await setConfig(panel, {motion: 'random', slides: IMAGES});
        await expect.poll(frames).toEqual([expect.stringMatching(random), expect.stringMatching(random)]);
    });

    test('panel-level fit applies to slides without their own', async ({page}) => {
        const panel = await mount(page, '<image-panel fit="contain" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect(panel.locator('img')).toHaveCSS('object-fit', 'contain');
    });
});


test.describe('navigation', () => {
    test('next, prev and goTo wrap round and fire slidechange', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await record(panel, 'slidechange');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await panel.evaluate(el => el.prev());
        await expect.poll(() => currentIndex(panel)).toBe(2);
        await panel.evaluate(el => el.next());
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await panel.evaluate(el => el.goTo(1));
        await expect.poll(() => currentIndex(panel)).toBe(1);

        const changes = (await events(page)).map(e => [e.detail.previousIndex, e.detail.index]);
        expect(changes).toEqual([[-1, 0], [0, 2], [2, 0], [0, 1]]);
    });

    test('fires slidechangeend once the transition finishes', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="200"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide').length)).toBe(1);

        await record(panel, 'slidechange', 'slidechangeend');
        await panel.evaluate(el => el.next());
        await expect.poll(async () => (await events(page)).length).toBe(2);

        expect((await events(page)).map(e => [e.type, e.detail.index])).toEqual([['slidechange', 1], ['slidechangeend', 1]]);
    });

    test('skips slidechangeend for an interrupted transition', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="300"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide').length)).toBe(1);

        await record(panel, 'slidechange', 'slidechangeend');
        await panel.evaluate(el => el.next());
        await expect.poll(async () => (await events(page)).length).toBe(1);
        await panel.evaluate(el => el.next());
        await expect.poll(async () => (await events(page)).some(e => e.type === 'slidechangeend')).toBe(true);

        expect((await events(page)).map(e => [e.type, e.detail.index])).toEqual([['slidechange', 1], ['slidechange', 2], ['slidechangeend', 2]]);
    });

    test('fades the outgoing slide out while the next fades in', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="1000"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide').length)).toBe(1);

        await panel.evaluate(el => el.next());
        await expect.poll(() => panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide').length)).toBe(2);
        await page.waitForTimeout(300);
        const [outgoing, incoming] = await panel.evaluate(el =>
            [...el.shadowRoot.querySelectorAll('.slide')].map(s => Number(getComputedStyle(s).opacity)));
        expect(outgoing).toBeLessThan(1);
        expect(incoming).toBeGreaterThan(0);
    });

    test('rapid navigation during transitions leaves a single slide', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="300"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        // Each call moves on from the previous target, not the slide still on screen
        await panel.evaluate(el => { for (let i = 0; i < 5; i++) el.next(); });
        await expect.poll(() => currentIndex(panel)).toBe(2);
        await expect(panel.locator('.slide')).toHaveCount(1);
    });

    test('on/off settings turned on by config can be turned off by property', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, {autoplay: true, shuffle: true, fillPanel: true, metadata: true, slides: IMAGES});
        const names = ['autoplay', 'shuffle', 'fillPanel', 'metadata'];
        const read = () => panel.evaluate((el, names) => names.map(name => el[name]), names);
        expect(await read()).toEqual([true, true, true, true]);

        await panel.evaluate((el, names) => names.forEach(name => el[name] = false), names);
        expect(await read()).toEqual([false, false, false, false]);
        expect(await panel.evaluate(el => el.getAttribute('fill-panel'))).toBe('false');

        await panel.evaluate((el, names) => names.forEach(name => el[name] = true), names);
        expect(await read()).toEqual([true, true, true, true]);
        expect(await panel.evaluate(el => el.getAttribute('fill-panel'))).toBe('');
    });

    test('without loop, navigation stops at either end', async ({page}) => {
        const panel = await mount(page, '<image-panel loop="false" keyboard transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await panel.evaluate(el => el.prev());
        await panel.evaluate(el => el.goTo(-1));
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(0);

        await panel.evaluate(el => el.goTo(2));
        await expect.poll(() => currentIndex(panel)).toBe(2);
        await panel.evaluate(el => el.next());
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(2);

        await panel.evaluate(el => el.loop = true);
        await panel.evaluate(el => el.next());
        await expect.poll(() => currentIndex(panel)).toBe(0);
    });

    test('loop can be turned off from config', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, {loop: false, slides: IMAGES});
        await expect.poll(() => currentIndex(panel)).toBe(0);
        expect(await panel.evaluate(el => el.loop)).toBe(false);

        // The attribute takes priority
        await panel.evaluate(el => el.setAttribute('loop', ''));
        expect(await panel.evaluate(el => el.loop)).toBe(true);
    });

    test('keyboard navigation, focusable only when enabled', async ({page}) => {
        const panel = await mount(page, '<image-panel keyboard transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect(panel).toHaveAttribute('tabindex', '0');
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await panel.focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => currentIndex(panel)).toBe(1);
        await page.keyboard.press('End');
        await expect.poll(() => currentIndex(panel)).toBe(2);
        await page.keyboard.press('Home');
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await panel.evaluate(el => el.keyboard = false);
        await expect(panel).not.toHaveAttribute('tabindex');
    });
});



/** Drags the mouse across the middle of the panel. Fast, unless `slow` spreads the moves out and pauses before letting go. */
async function mouseDrag(page, panel, dx, dy = 0, {slow = false} = {})
{
    const box = await panel.boundingBox();
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (slow)
    {
        for (let i = 1; i <= 10; i++)
        {
            await page.mouse.move(x + dx * i / 10, y + dy * i / 10);
            await page.waitForTimeout(30);
        }
        await page.waitForTimeout(150);
    }
    else
    {
        await page.mouse.move(x + dx, y + dy, {steps: 8});
    }
    await page.mouse.up();
}

/**
 * Drags with synthetic pointer events, for pointers Playwright can't drive (pen, and touch outside Chromium) and for
 * flicks, since its mouse moves come a frame apart. Each leg moves to `to` px from the start in `steps` moves 5ms apart,
 * after waiting `pause` ms.
 */
function pointerDrag(panel, pointerType, ...legs)
{
    return panel.evaluate(async (el, {pointerType, legs}) => {
        const box = el.getBoundingClientRect();
        const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const fire = (type, offset) => el.dispatchEvent(new PointerEvent(type, {
            pointerId: 7, pointerType, isPrimary: true, button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1, clientX: x + offset, clientY: y, bubbles: true, composed: true,
        }));
        let at = 0;
        fire('pointerdown', 0);
        for (const {to, steps = 8, pause = 0} of legs)
        {
            await wait(pause);
            const from = at;
            for (let i = 1; i <= steps; i++)
            {
                await wait(5);
                fire('pointermove', at = from + (to - from) * i / steps);
            }
        }
        fire('pointerup', at);
    }, {pointerType, legs: legs.map(leg => typeof leg === 'number' ? {to: leg} : leg)});
}

/** A real touch drag through the DevTools protocol, so the browser applies touch-action. Chromium only. */
async function touchDrag(page, panel, dx, dy)
{
    const cdp = await page.context().newCDPSession(page);
    const box = await panel.boundingBox();
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    const touch = (type, fraction) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{x: x + dx * fraction, y: y + dy * fraction}],
    });
    await touch('touchStart', 0);
    for (let i = 1; i <= 10; i++)
    {
        await touch('touchMove', i / 10);
    }
    await touch('touchEnd', 1);
}

test.describe('swipe', () => {
    test('a horizontal mouse drag navigates, with a swipe trigger', async ({page}) => {
        const panel = await mount(page, '<image-panel swipe transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await record(panel, 'slidechange');

        await mouseDrag(page, panel, -120);
        await expect.poll(() => currentIndex(panel)).toBe(1);
        await mouseDrag(page, panel, 120);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await mouseDrag(page, panel, 120);
        await expect.poll(() => currentIndex(panel)).toBe(2);

        expect((await events(page)).map(e => [e.detail.index, e.detail.trigger])).toEqual([[1, 'swipe'], [0, 'swipe'], [2, 'swipe']]);
    });

    test('a slow drag needs to go far enough, and flicking back cancels it', async ({page}) => {
        const panel = await mount(page, '<image-panel swipe transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await mouseDrag(page, panel, -30, 0, {slow: true});
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(0);

        await mouseDrag(page, panel, -80, 0, {slow: true});
        await expect.poll(() => currentIndex(panel)).toBe(1);

        // A short, quick flick is enough
        await pointerDrag(panel, 'mouse', -25);
        await expect.poll(() => currentIndex(panel)).toBe(2);

        // Dragged well past the distance, then flicked back the other way
        await pointerDrag(panel, 'mouse', -100, {to: -70, steps: 3, pause: 150});
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(2);
    });

    test('ignores vertical drags, clicks and a panel without swipe', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await mouseDrag(page, panel, -120);
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(0);

        await panel.evaluate(el => el.swipe = true);
        await expect(panel).toHaveAttribute('swipe', '');
        await mouseDrag(page, panel, -40, 100);
        await panel.click();
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(0);
    });

    test('a click that ends a drag is suppressed, and other clicks are not', async ({page}) => {
        const panel = await mount(page, '<image-panel swipe transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await page.evaluate(() => {
            window.clicks = 0;
            document.addEventListener('click', () => window.clicks++);
        });

        await mouseDrag(page, panel, -120);
        await expect.poll(() => currentIndex(panel)).toBe(1);
        // A drag that snaps back is still a drag
        await mouseDrag(page, panel, -20, 0, {slow: true});
        expect(await page.evaluate(() => window.clicks)).toBe(0);

        await panel.click();
        expect(await page.evaluate(() => window.clicks)).toBe(1);
    });

    test('follows the writing direction, and respects loop="false" at the ends', async ({page}) => {
        const panel = await mount(page, '<image-panel swipe dir="rtl" loop="false" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        // Right to left, dragging left goes back, and there's nothing before the first slide
        await mouseDrag(page, panel, -120);
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(0);

        await mouseDrag(page, panel, 120);
        await expect.poll(() => currentIndex(panel)).toBe(1);
        await mouseDrag(page, panel, 120);
        await expect.poll(() => currentIndex(panel)).toBe(2);
        await mouseDrag(page, panel, 120);
        await page.waitForTimeout(100);
        expect(await currentIndex(panel)).toBe(2);
    });

    test('holds auto-advance during the drag, and restarts the countdown after', async ({page}) => {
        const panel = await mount(page, '<image-panel swipe autoplay interval="5000" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await record(panel, 'hold', 'resume', 'countdown', 'slidechange');

        await mouseDrag(page, panel, -30, 0, {slow: true});
        await mouseDrag(page, panel, -120);
        await expect.poll(() => currentIndex(panel)).toBe(1);

        const log = (await events(page)).map(e => [e.type, e.detail.trigger]);
        expect(log).toEqual([
            // Snapped back: the countdown carries on from where it was
            ['hold', 'swipe'],
            ['resume', 'swipe'],
            ['countdown', 'swipe'],
            // Swiped: a fresh countdown for the new slide
            ['hold', 'swipe'],
            ['resume', 'swipe'],
            ['slidechange', 'swipe'],
            ['countdown', 'swipe'],
        ]);
        expect((await events(page)).at(-1).detail.remaining).toBe(5000);
    });

    for (const pointerType of ['pen', 'touch'])
    {
        test(`works with ${pointerType} pointers`, async ({page}) => {
            const panel = await mount(page, '<image-panel swipe transition-duration="0"></image-panel>');
            await setConfig(panel, IMAGES);
            await expect.poll(() => currentIndex(panel)).toBe(0);

            await expect(panel).toHaveCSS('touch-action', 'pan-y pinch-zoom');

            await pointerDrag(panel, pointerType, -120);
            await expect.poll(() => currentIndex(panel)).toBe(1);
            await pointerDrag(panel, pointerType, 120);
            await expect.poll(() => currentIndex(panel)).toBe(0);
        });
    }

    test.describe('real touch', () => {
        test.skip(({browserName}) => browserName !== 'chromium', 'touch input through the DevTools protocol');
        test.use({hasTouch: true});

        test('swipes horizontally, and leaves vertical drags to scroll the page', async ({page}) => {
            const panel = await mount(page, '<image-panel swipe transition-duration="0"></image-panel><div style="height: 3000px"></div>');
            await setConfig(panel, IMAGES);
            await expect.poll(() => currentIndex(panel)).toBe(0);
            await expect(panel).toHaveCSS('touch-action', 'pan-y pinch-zoom');

            await touchDrag(page, panel, -150, 0);
            await expect.poll(() => currentIndex(panel)).toBe(1);

            await touchDrag(page, panel, 0, -120);
            await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
            await page.waitForTimeout(100);
            expect(await currentIndex(panel)).toBe(1);
        });
    });
});


test.describe('transitions', () => {
    /** Starts a transition to the next slide, and returns what's animating on each slide and the dip layer. */
    async function transitionTo(panel, config, move = 'next')
    {
        await setConfig(panel, config);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await expect(panel.locator('.slide')).toHaveCount(1);
        await panel.evaluate((el, method) => el[method](), move);
        await expect(panel.locator('.slide')).toHaveCount(2);
        return panel.evaluate(el => {
            const frames = node => node.getAnimations().filter(a => a.id !== 'motion')
                .flatMap(a => a.effect.getKeyframes().map(({translate, clipPath, opacity}) => translate ? offset(translate) : clipPath ?? opacity));
            // Browsers serialise translate differently ("0 0", "0px", "100%"), so compare as [x, y] percentages
            const offset = value => {
                const [x, y = 0] = value.split(' ').map(parseFloat);
                return `${x} ${y}`;
            };
            const [outgoing, incoming] = el.shadowRoot.querySelectorAll('.slide');
            const dip = el.shadowRoot.querySelector('.dip');
            return {
                incoming: frames(incoming),
                outgoing: frames(outgoing),
                dip: frames(dip),
                dipColor: dip.style.backgroundColor,
                blend: incoming.classList.contains('blend'),
            };
        });
    }

    test('fade is the default, and blends the slides', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="1000"></image-panel>');
        const result = await transitionTo(panel, IMAGES);
        expect(result).toMatchObject({incoming: ['0', '1'], outgoing: ['1', '0'], blend: true});
        // The blend is only for the fade itself
        await expect(panel.locator('.slide')).toHaveCount(1);
        await expect(panel.locator('.slide')).not.toHaveClass(/blend/);
    });

    test('dip fades through a colour, swapping slides halfway', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="dip white" transition-duration="1000"></image-panel>');
        const result = await transitionTo(panel, IMAGES);
        expect(result).toMatchObject({dip: ['0', '1', '0'], dipColor: 'white', blend: false});

        await page.waitForTimeout(200);
        const [outgoing, incoming] = await panel.evaluate(el =>
            [...el.shadowRoot.querySelectorAll('.slide')].map(s => Number(getComputedStyle(s).opacity)));
        expect([outgoing, incoming]).toEqual([1, 0]);
    });

    test('plain dip uses the CSS custom property', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="dip" transition-duration="1000" style="--image-panel-dip-color: rgb(255, 0, 0)"></image-panel>');
        await transitionTo(panel, IMAGES);
        expect(await panel.evaluate(el => getComputedStyle(el.shadowRoot.querySelector('.dip')).backgroundColor)).toBe('rgb(255, 0, 0)');
    });

    test('push moves both slides, following the navigation direction', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="push" transition-duration="1000"></image-panel>');
        expect(await transitionTo(panel, IMAGES)).toMatchObject({incoming: ['100 0', '0 0'], outgoing: ['0 0', '-100 0']});
        expect(await transitionTo(panel, IMAGES, 'prev')).toMatchObject({incoming: ['-100 0', '0 0'], outgoing: ['0 0', '100 0']});
    });

    test('directions follow the writing direction', async ({page}) => {
        const panel = await mount(page, '<image-panel dir="rtl" transition="slide" transition-duration="1000"></image-panel>');
        expect(await transitionTo(panel, IMAGES)).toMatchObject({incoming: ['-100 0', '0 0'], outgoing: []});
    });

    test('slide and push take explicit directions', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="slide down-left" transition-duration="1000"></image-panel>');
        expect((await transitionTo(panel, IMAGES)).incoming).toEqual(['100 -100', '0 0']);
    });

    test('wipe masks the incoming slide behind a moving edge, optionally feathered', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="wipe up" transition-duration="1000"></image-panel>');
        const mask = () => panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide')[1]?.style.maskImage);
        const animated = () => panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide')[1].getAnimations()
            .flatMap(a => a.effect.getKeyframes().map(k => k['--image-panel-wipe'])));

        expect(await transitionTo(panel, IMAGES)).toMatchObject({outgoing: []});
        expect(await mask()).toMatch(/^linear-gradient\(to top, black calc\(var\(--image-panel-wipe\) - 0px\), transparent var\(--image-panel-wipe\)\)$/);
        expect((await animated()).length).toBe(2);

        await panel.evaluate(el => el.transition = 'wipe 12% down-right');
        await transitionTo(panel, IMAGES);
        expect(await mask()).toContain('to bottom right');
        expect(await mask()).toContain('- 12%');

        // Halfway through, the edge is part-way across
        await page.waitForTimeout(400);
        const wipe = await panel.evaluate(el => getComputedStyle(el.shadowRoot.querySelectorAll('.slide')[1]).getPropertyValue('--image-panel-wipe'));
        expect(wipe).not.toMatch(/^0%?$/);

        // The mask is removed once the slide is fully revealed
        await expect(panel.locator('.slide')).toHaveCount(1);
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.slide').style.maskImage)).toBe('');
    });

    test('a bare number feathers in pixels', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="wipe 40" transition-duration="1000"></image-panel>');
        await transitionTo(panel, IMAGES);
        expect(await panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide')[1].style.maskImage)).toContain('to left, black calc(var(--image-panel-wipe) - 40px)');
    });

    test('slides clip their image, so rotated images move with straight edges', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, [{src: IMAGES[0], transform: 'rotate(-4deg)'}]);
        await expect(panel.locator('.slide')).toHaveCount(1);
        expect(await panel.evaluate(el => getComputedStyle(el.shadowRoot.querySelector('.slide')).overflow)).toBe('clip');
    });

    test('random, cardinal and diagonal pick from their sets', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="1000"></image-panel>');
        const pick = async transition => {
            await panel.evaluate((el, value) => el.transition = value, transition);
            return (await transitionTo(panel, IMAGES)).incoming[0];
        };
        const isDiagonal = frame => !frame.split(' ').includes('0');
        for (let i = 0; i < 3; i++)
        {
            expect(isDiagonal(await pick('slide diagonal'))).toBe(true);
            expect(isDiagonal(await pick('slide cardinal'))).toBe(false);
            expect(isDiagonal(await pick('push random'))).toBe(false);
        }
    });

    test('transition easing applies to moving transitions, from the panel or the slide', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="push" transition-easing="ease-out" transition-duration="1000"></image-panel>');
        const easings = () => panel.evaluate(el => [...el.shadowRoot.querySelectorAll('.slide')]
            .map(slide => slide.getAnimations().filter(a => a.id !== 'motion').map(a => a.effect.getTiming().easing)));

        await transitionTo(panel, IMAGES);
        expect(await easings()).toEqual([['ease-out'], ['ease-out']]);

        await transitionTo(panel, [IMAGES[0], {src: IMAGES[1], transition: 'wipe', transitionEasing: 'cubic-bezier(0.16, 1, 0.3, 1)'}]);
        expect((await easings())[1]).toEqual(['cubic-bezier(0.16, 1, 0.3, 1)']);

        // Fade keeps its linear blend
        await panel.evaluate(el => el.transition = 'fade');
        await transitionTo(panel, IMAGES);
        expect(await easings()).toEqual([['linear'], ['linear']]);
    });

    test('an invalid easing falls back to the default', async ({page}) => {
        const warnings = [];
        page.on('console', message => message.type() === 'warning' && warnings.push(message.text()));
        const panel = await mount(page, '<image-panel transition="slide" transition-easing="wobbly" transition-duration="1000"></image-panel>');
        await transitionTo(panel, IMAGES);
        expect(await panel.evaluate(el => el.shadowRoot.querySelectorAll('.slide')[1].getAnimations()[0].effect.getTiming().easing)).toBe('ease-in-out');
        expect(warnings.some(text => text.includes('wobbly'))).toBe(true);
    });

    test('fill-panel covers the panel: fit, image transform, motion and easing', async ({page}) => {
        const panel = await mount(page, `<image-panel fill-panel fit="contain" autoplay interval="5000" transition="push"
            transition-easing="cubic-bezier(0.34, 1.56, 0.64, 1)" transition-duration="1000" style="width: 400px; height: 200px"></image-panel>`);
        await transitionTo(panel, [IMAGES[0], {
            src: IMAGES[1],
            transform: 'rotate(10deg)',
            motion: {from: 'scale(0.8)', to: 'scale(1.2) translate(20%, 0)', easing: 'linear(0, 1.2 60%, 1)'},
        }]);
        const result = await panel.evaluate(el => {
            const slide = el.shadowRoot.querySelectorAll('.slide')[1];
            const img = slide.querySelector('img');
            const motion = slide.querySelector('.motion').getAnimations().find(a => a.id === 'motion');
            const zoom = img.getAnimations().find(a => a.id === 'motion-zoom');
            return {
                fit: getComputedStyle(img).objectFit,
                transform: img.style.transform,
                frames: motion.effect.getKeyframes().map(k => k.transform),
                zooms: zoom.effect.getKeyframes().map(k => Number(k.scale)),
                zoomEasing: zoom.effect.getTiming().easing,
                motionEasing: motion.effect.getTiming().easing,
                easing: slide.getAnimations().find(a => a.id !== 'motion').effect.getTiming().easing,
            };
        });
        expect(result.fit).toBe('cover');
        expect(result.easing).toBe('cubic-bezier(0.34, 1, 0.64, 1)');
        expect(result.motionEasing).toMatch(/^linear\(0( 0%)?, 1 60%, 1( 100%)?\)$/);
        expect(result.zoomEasing).toBe(result.motionEasing);

        // Rotating a 2:1 box by 10° needs cos 10° + 2 sin 10° ≈ 1.332 to cover it
        const zoom = transform => Number(transform.match(/scale\(([\d.]+)\)$/)?.[1] ?? 1);
        expect(result.transform).toMatch(/^rotate\(10deg\) scale\(/);
        expect(zoom(result.transform)).toBeCloseTo(Math.cos(Math.PI / 18) + 2 * Math.sin(Math.PI / 18), 3);
        // The motion itself is left as written; the image zooms instead. 0.8 is zoomed back up to cover.
        // Translating after scale(1.2) pans 24% of the panel, which needs a total zoom of 1.48, since each
        // side only has (scale - 1) / 2 to spare. Each has a 0.5% margin.
        expect(result.frames[0]).toBe('scale(0.8)');
        expect(result.frames[1]).toMatch(/^scale\(1.2\) translate\(20%(, 0(px)?)?\)$/);
        expect(result.zooms.at(0)).toBeCloseTo(1.25 * 1.005, 3);
        expect(result.zooms.at(-1)).toBeCloseTo(1.48 / 1.2 * 1.005, 3);
    });

    test('fill-panel covers the panel throughout a motion, not just at its keyframes', async ({page}) => {
        const panel = await mount(page, `<image-panel fill-panel autoplay interval="5000" transition-duration="1000"
            style="width: 400px; height: 200px"></image-panel>`);
        // The zoom a rotation needs is a curve: halfway, rotate(10deg) needs ≈ 1.332, more than the
        // average of the two ends (1 and ≈ 1.624) blended in a straight line
        await transitionTo(panel, [IMAGES[0], {src: IMAGES[1], motion: ['none', 'rotate(20deg)', 'rotate(-30deg) translate(10%, 5%)']}]);
        expect(await motionShortfall(panel)).toBeLessThanOrEqual(0);
    });

    test('fill-panel works the zoom out again when the panel changes shape', async ({page}) => {
        const panel = await mount(page, `<image-panel fill-panel autoplay interval="5000" transition-duration="1000"
            style="width: 400px; height: 200px"></image-panel>`);
        await transitionTo(panel, [IMAGES[0], {src: IMAGES[1], transform: 'rotate(10deg)', motion: ['none', 'rotate(20deg)']}]);
        const zoom = () => panel.evaluate(el => Number(el.shadowRoot.querySelector('.slide:last-child img').style.transform
            .match(/^rotate\(10deg\) scale\(([\d.]+)\)$/)?.[1]));
        const angle = Math.PI / 18;
        expect(await zoom()).toBeCloseTo(Math.cos(angle) + 2 * Math.sin(angle), 3);

        // A square only needs cos θ + sin θ: worked out afresh, not zoomed again on top
        await panel.evaluate(el => el.style.height = '400px');
        await expect.poll(zoom).toBeCloseTo(Math.cos(angle) + Math.sin(angle), 3);
        expect(await motionShortfall(panel)).toBeLessThanOrEqual(0);
    });

    test('fill-panel covers a slide that was shown while the panel had no size', async ({page}) => {
        const panel = await mount(page, `<image-panel fill-panel autoplay interval="5000" transition-duration="1000"
            style="width: 400px; height: 200px"></image-panel>`);
        await setConfig(panel, [IMAGES[0], {src: IMAGES[1], transform: 'rotate(10deg)', motion: ['none', 'rotate(20deg)']}]);
        await expect(panel.locator('.slide')).toHaveCount(1);
        await panel.evaluate(el => {
            el.style.height = '0';
            el.next();
        });
        await expect(panel.locator('.slide')).toHaveCount(2);
        const transform = () => panel.evaluate(el => el.shadowRoot.querySelector('.slide:last-child img').style.transform);
        expect(await transform()).toBe('rotate(10deg)');

        await panel.evaluate(el => el.style.height = '200px');
        await expect.poll(transform).toMatch(/^rotate\(10deg\) scale\(/);
        expect(await motionShortfall(panel)).toBeLessThanOrEqual(0);
    });

    test('fill-panel clamps linear() stops written either way round, and in exponent form', async ({page}) => {
        const panel = await mount(page, `<image-panel fill-panel transition="slide" transition-duration="1000"
            transition-easing="linear(-0.2, 60% 1.2, 1.5e+0 80%, 1)"></image-panel>`);
        await transitionTo(panel, IMAGES);
        const easing = await panel.evaluate(el => el.shadowRoot.querySelector('.slide:last-child').getAnimations()
            .find(a => a.id !== 'motion').effect.getTiming().easing);
        expect(easing).toMatch(/^linear\(0( 0%)?, 1 60%, 1 80%, 1( 100%)?\)$/);
    });

    test('fill-panel zooms about the centre, whatever the transform origin', async ({page}) => {
        const panel = await mount(page, `<image-panel fill-panel transition-duration="1000"
            style="width: 400px; height: 200px"></image-panel>`);
        await transitionTo(panel, [IMAGES[0], {src: IMAGES[1], style: 'transform-origin: 0 0', transform: 'rotate(10deg)'}]);
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.slide:last-child img').style.transform))
            .toMatch(/^rotate\(10deg\) translate\(200px, 100px\) scale\([\d.]+\) translate\(-200px, -100px\)$/);
        expect(await uncovered(panel)).toEqual([]);
    });

    for (const transform of ['perspective(500px) rotateY(20deg)', 'perspective(400px) rotateX(-25deg) rotateZ(5deg) translateZ(-50px)'])
    {
        test(`fill-panel covers with a 3D transform: ${transform}`, async ({page}) => {
            const panel = await mount(page, `<image-panel fill-panel transition-duration="1000"
                style="width: 400px; height: 200px"></image-panel>`);
            await transitionTo(panel, [IMAGES[0], {src: IMAGES[1], transform}]);
            expect(await uncovered(panel)).toEqual([]);
        });
    }

    test('fill-panel covers motion with moved transform origins and 3D', async ({page}) => {
        const panel = await mount(page, `<style>image-panel::part(motion) { transform-origin: 0 0 }</style>
            <image-panel fill-panel autoplay interval="5000" transition-duration="1000"
            style="width: 400px; height: 200px"></image-panel>`);
        await transitionTo(panel, [IMAGES[0], {src: IMAGES[1], style: 'transform-origin: 100% 0', motion: ['none', 'rotate(15deg)']}]);
        expect((await uncovered(panel, 40)).length, 'origins').toBe(0);
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.slide:last-child img').getAnimations()
            .find(a => a.id === 'motion-zoom').effect.getKeyframes().at(-1).translate)).toBeTruthy();

        await transitionTo(panel, [IMAGES[0], {src: IMAGES[2], motion: ['perspective(600px) rotateY(0deg)', 'perspective(600px) rotateY(25deg)']}]);
        expect((await uncovered(panel, 40)).length, '3D').toBe(0);
    });

    test('without fill-panel, settings are left alone', async ({page}) => {
        const panel = await mount(page, '<image-panel fit="contain" transition="slide" transition-easing="cubic-bezier(0.34, 1.56, 0.64, 1)" transition-duration="1000"></image-panel>');
        await transitionTo(panel, [IMAGES[0], {src: IMAGES[1], transform: 'rotate(10deg)'}]);
        const result = await panel.evaluate(el => {
            const slide = el.shadowRoot.querySelectorAll('.slide')[1];
            const img = slide.querySelector('img');
            return [getComputedStyle(img).objectFit, img.style.transform, slide.getAnimations()[0].effect.getTiming().easing];
        });
        expect(result).toEqual(['contain', 'rotate(10deg)', 'cubic-bezier(0.34, 1.56, 0.64, 1)']);
    });

    test('push ignores diagonal directions', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="push up-left" transition-duration="1000"></image-panel>');
        expect((await transitionTo(panel, IMAGES)).incoming).toEqual(['100 0', '0 0']);
        await panel.evaluate(el => el.transition = 'push diagonal');
        expect((await transitionTo(panel, IMAGES)).incoming).toEqual(['100 0', '0 0']);
    });

    test('slides can set their own transition, or none', async ({page}) => {
        const panel = await mount(page, '<image-panel transition="push" transition-duration="1000"></image-panel>');
        await setConfig(panel, [IMAGES[0], {src: IMAGES[1], transition: 'none'}, {src: IMAGES[2], transition: 'dip'}]);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await expect(panel.locator('.slide')).toHaveCount(1);

        await record(panel, 'slidechange', 'slidechangeend');
        await panel.evaluate(el => el.next());
        await expect.poll(async () => (await events(page)).length).toBe(2);
        await expect(panel.locator('.slide')).toHaveCount(1);

        await panel.evaluate(el => el.next());
        await expect(panel.locator('.slide')).toHaveCount(2);
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.dip').getAnimations().length)).toBe(1);
    });

    test('transition comes from the config too', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="1000"></image-panel>');
        expect((await transitionTo(panel, {transition: 'slide up', slides: IMAGES})).incoming).toEqual(['0 100', '0 0']);
        expect(await panel.evaluate(el => el.transition)).toBe('slide up');
    });
});

test.describe('focal point', () => {
    // Markermeer.jpg is 1920 × 960. Covering a 400 × 300 panel draws it 600 × 300, so 200px can be cropped across.
    const frameOf = panel => panel.evaluate(el => {
        const frame = el.shadowRoot.querySelector('.slide:last-child .motion');
        const motion = frame?.getAnimations().find(a => a.id === 'motion');
        return {
            origin: frame && getComputedStyle(frame).transformOrigin,
            keyframes: motion?.effect.getKeyframes().map(k => k.transform) ?? null,
        };
    });
    const objectPosition = panel => panel.evaluate(el => el.shadowRoot.querySelector('.slide:last-child img')?.style.objectPosition ?? null);

    test('reads keywords, percentages and edge offsets', async ({page}) => {
        await page.goto('/tests/fixture.html');
        const parsed = await page.evaluate(async () => {
            const {parseFocalPoint, parseFocalRange} = await import('/src/focus.js');
            const points = ['center', 'left', 'top', '25% 40%', '30%', 'left top', 'top left', 'left 30%', '30% bottom',
                'left 30% top 20%', 'right 10% bottom', 'bottom 10% right 20%', 'center top 25%',
                'top 30%', 'left right', '10px 20px', 'left 30% 20%', 'nonsense', ''];
            const ranges = ['0%', '40%', '40% 10%', '150%', '0.4', '10% 20% 30%', '-10%'];
            return {
                points: Object.fromEntries(points.map(value => [value, parseFocalPoint(value)])),
                ranges: Object.fromEntries(ranges.map(value => [value, parseFocalRange(value)])),
            };
        });
        const near = ([x, y]) => [expect.closeTo(x, 6), expect.closeTo(y, 6)];
        expect(parsed.points).toEqual({
            'center': [0.5, 0.5],
            'left': [0, 0.5],
            'top': [0.5, 0],
            '25% 40%': near([0.25, 0.4]),
            '30%': near([0.3, 0.5]),
            'left top': [0, 0],
            'top left': [0, 0],
            'left 30%': near([0, 0.3]),
            '30% bottom': near([0.3, 1]),
            'left 30% top 20%': near([0.3, 0.2]),
            'right 10% bottom': near([0.9, 1]),
            'bottom 10% right 20%': near([0.8, 0.9]),
            'center top 25%': near([0.5, 0.25]),
            // Not valid background-positions, or lengths, which aren't accepted
            'top 30%': null, 'left right': null, '10px 20px': null, 'left 30% 20%': null, 'nonsense': null, '': null,
        });
        expect(parsed.ranges).toEqual({
            '0%': [0, 0], '40%': [0.4, 0.4], '40% 10%': [0.4, 0.1], '150%': [1, 1],
            '0.4': null, '10% 20% 30%': null, '-10%': null,
        });
    });

    test('a cover crop centres on the focal point, as far as the image allows', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0" position="right"></image-panel>');
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '40% 50%'}, {src: IMAGES[0], focalPoint: 'left 10%'}, {src: IMAGES[0], focalPoint: '75%'}]);
        // 200 - 0.4 × 600: the point is 40px right of centre unless the image moves 40px left. Nothing to crop vertically.
        await expect.poll(() => objectPosition(panel)).toBe('-40px 0px');
        await panel.evaluate(el => el.next());
        await expect.poll(() => objectPosition(panel)).toBe('0px 0px');
        await panel.evaluate(el => el.next());
        // Never pulled away from the edge: it can only move 200px
        await expect.poll(() => objectPosition(panel)).toBe('-200px 0px');
    });

    test('from the attribute, child images, and the config; "none" opts a slide out', async ({page}) => {
        const panel = await mount(page, `<image-panel transition-duration="0" focal-point="40% 50%">
            <img src="${IMAGES[0]}" alt=""><img src="${IMAGES[0]}" alt="" data-focal-point="left"><img src="${IMAGES[0]}" alt="" data-focal-point="none">
        </image-panel>`);
        await expect.poll(() => objectPosition(panel)).toBe('-40px 0px');
        await panel.evaluate(el => el.next());
        await expect.poll(() => objectPosition(panel)).toBe('0px 0px');
        await panel.evaluate(el => el.next());
        await expect.poll(() => currentIndex(panel)).toBe(2);
        expect(await objectPosition(panel)).toBe('');

        expect(await panel.evaluate(el => [el.focalPoint, el.focalRange])).toEqual(['40% 50%', '']);
        await panel.evaluate(el => { el.removeAttribute('focal-point'); el.config = {focalPoint: '30%', focalRange: '20%', slides: []}; });
        expect(await panel.evaluate(el => [el.focalPoint, el.focalRange])).toEqual(['30%', '20%']);
        await panel.evaluate(el => { el.focalPoint = 'left'; el.focalRange = '10% 0%'; });
        expect(await panel.evaluate(el => [el.getAttribute('focal-point'), el.getAttribute('focal-range')])).toEqual(['left', '10% 0%']);
        // focus() is still the element's own
        expect(await panel.evaluate(el => typeof el.focus)).toBe('function');
    });

    test('letterboxed axes keep their position, and overflowing ones follow the point', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0" fit="none" position="right" style="width: 2000px; height: 300px"></image-panel>');
        // Drawn at 1920 × 960: 80px spare across, aligned right, and 660px to crop down, about the point at 240px
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '50% 25%'}]);
        await expect.poll(() => objectPosition(panel)).toBe('80px -90px');

        // Nothing overflows with contain, so the position is left as it is
        await setConfig(panel, [{src: IMAGES[0], fit: 'contain', focalPoint: '50% 25%'}]);
        await expect.poll(() => panel.evaluate(el => getComputedStyle(el.shadowRoot.querySelector('img')).objectFit)).toBe('contain');
        expect(await objectPosition(panel)).toMatch(/^right( center)?$/);
    });

    test('the crop is worked out again when the panel changes size', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '40% 50%'}]);
        await expect.poll(() => objectPosition(panel)).toBe('-40px 0px');
        // 300 × 300: drawn 600 × 300, 150 - 240
        await panel.evaluate(el => el.style.width = '300px');
        await expect.poll(() => objectPosition(panel)).toBe('-90px 0px');
    });

    test('explicit motion pivots on the focal point, unless it sets an origin', async ({page}) => {
        const panel = await mount(page, `<image-panel autoplay interval="5000" transition-duration="0"></image-panel>`);
        // The point ends up 160px across a 400 × 300 panel: 0.4 × 600 - 80, the most the crop can move it
        await setConfig(panel, [
            {src: IMAGES[0], focalPoint: '40% 20%', motion: ['scale(1)', 'scale(1.2)']},
            {src: IMAGES[0], focalPoint: '40% 20%', flip: 'horizontal', motion: ['scale(1)', 'scale(1.2)']},
            {src: IMAGES[0], focalPoint: '40% 20%', motion: {from: 'scale(1)', to: 'scale(1.2)', origin: 'center'}},
            {src: IMAGES[0], motion: ['scale(1)', 'scale(1.2)']},
        ]);
        await expect.poll(async () => (await frameOf(panel)).origin).toBe('200px 60px');
        expect((await frameOf(panel)).keyframes).toEqual(['scale(1)', 'scale(1.2)']);
        await panel.evaluate(el => el.next());
        // Flipped, the point is mirrored
        await expect.poll(async () => (await frameOf(panel)).origin).toBe('200px 60px');
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '30% 20%', flip: 'horizontal', motion: ['scale(1)', 'scale(1.2)']}]);
        // 0.3 × 600 - 200 = -20: clamped to 0, so the point is 180px in, and 220px once flipped
        await expect.poll(async () => (await frameOf(panel)).origin).toBe('220px 60px');

        await setConfig(panel, [{src: IMAGES[0], focalPoint: '40% 20%', motion: {from: 'scale(1)', to: 'scale(1.2)', origin: 'left top'}}]);
        await expect.poll(async () => (await frameOf(panel)).origin).toBe('0px 0px');
        await setConfig(panel, [{src: IMAGES[0], motion: ['scale(1)', 'scale(1.2)']}]);
        await expect.poll(async () => (await frameOf(panel)).origin).toBe('200px 150px');
    });

    test('::part(motion) transform-origin still wins', async ({page}) => {
        const panel = await mount(page, `<style>image-panel::part(motion) { transform-origin: 0 0 }</style>
            <image-panel autoplay interval="5000" transition-duration="0"></image-panel>`);
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '40% 20%', motion: ['scale(1)', 'scale(1.2)']}]);
        await expect.poll(async () => (await frameOf(panel)).keyframes).toEqual(['scale(1)', 'scale(1.2)']);
        expect((await frameOf(panel)).origin).toBe('0px 0px');
    });

    test('random motion zooms about the focal point, keeping it as central as it can', async ({page}) => {
        const panel = await mount(page, `<image-panel autoplay interval="5000" transition-duration="0" motion="random"></image-panel>`);
        const landings = async () => {
            const {origin, keyframes} = await frameOf(panel);
            const [ox, oy] = origin.split(' ').map(value => parseFloat(value));
            return keyframes.map(transform => {
                const [, tx, ty, scale] = transform.match(/^translate\((-?[\d.]+)%, (-?[\d.]+)%\) scale\(([\d.]+)\)$/).map(Number);
                // Where the point lands, and how far the scaled frame's edges are inside the panel (≥ 0 covers it)
                return {
                    x: ox / 400 + tx / 100, y: oy / 300 + ty / 100, scale,
                    spare: Math.min(ox / 400 * (scale - 1) - tx / 100, (1 - ox / 400) * (scale - 1) + tx / 100,
                        oy / 300 * (scale - 1) - ty / 100, (1 - oy / 300) * (scale - 1) + ty / 100),
                };
            });
        };

        // A central point stays put: the motion is a zoom about it
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '50% 50%'}]);
        await expect.poll(async () => (await frameOf(panel)).keyframes?.length).toBe(2);
        for (const {x, y} of await landings())
        {
            expect(x).toBeCloseTo(0.5, 3);
            expect(y).toBeCloseTo(0.5, 3);
        }

        // Near the top, it can only get as close to the centre as the zoom lets the frame move down
        for (let i = 0; i < 5; i++)
        {
            await setConfig(panel, [{src: IMAGES[0], focalPoint: '50% 10%'}]);
            await expect.poll(async () => (await frameOf(panel)).origin).toBe('200px 30px');
            for (const {x, y, scale, spare} of await landings())
            {
                expect(x).toBeCloseTo(0.5, 3);
                expect(y).toBeCloseTo(0.1 * scale - (scale - 1) * 0.05, 3);
                expect(spare).toBeGreaterThanOrEqual(-0.0001);
            }
        }

        // With range, it wanders, but no further than allowed, and never uncovers the panel
        for (let i = 0; i < 5; i++)
        {
            await setConfig(panel, {focalRange: '40% 0%', slides: [{src: IMAGES[0], focalPoint: '50% 50%'}]});
            await expect.poll(async () => (await frameOf(panel)).keyframes?.length).toBe(2);
            for (const {x, y, spare} of await landings())
            {
                expect(Math.abs(x - 0.5)).toBeLessThanOrEqual(0.2001);
                expect(y).toBeCloseTo(0.5, 3);
                expect(spare).toBeGreaterThanOrEqual(-0.0001);
            }
        }
        expect(await uncovered(panel, 20)).toEqual([]);
    });

    test('fill-panel crops a contained image about the point and still covers the motion', async ({page}) => {
        const panel = await mount(page, `<image-panel fill-panel fit="contain" autoplay interval="5000" transition-duration="0"
            motion="random" focal-range="100%"></image-panel>`);
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '40% 50%', transform: 'rotate(5deg)'}]);
        await expect.poll(() => objectPosition(panel)).toBe('-40px 0px');
        expect(await panel.evaluate(el => getComputedStyle(el.shadowRoot.querySelector('img')).objectFit)).toBe('cover');
        expect(await motionShortfall(panel)).toBeLessThanOrEqual(0);
    });

    test('invalid values are ignored with a warning', async ({page}) => {
        const warnings = [];
        page.on('console', message => message.type() === 'warning' && warnings.push(message.text()));
        const panel = await mount(page, '<image-panel transition-duration="0" focal-range="lots"></image-panel>');
        await setConfig(panel, [{src: IMAGES[0], focalPoint: '10px 20px'}, {src: IMAGES[0], focalPoint: '40%'}]);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        expect(await objectPosition(panel)).toBe('');
        await panel.evaluate(el => el.next());
        await expect.poll(() => objectPosition(panel)).toBe('-40px 0px');
        expect(warnings.some(text => text.includes('focal point "10px 20px"'))).toBe(true);
        expect(warnings.some(text => text.includes('focal range "lots"'))).toBe(true);
    });
});


test.describe('playback', () => {
    test('autoplays, and pause() stops it', async ({page}) => {
        const panel = await mount(page, '<image-panel autoplay interval="150" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(2);

        await panel.evaluate(el => el.pause());
        const index = await currentIndex(panel);
        await page.waitForTimeout(400);
        expect(await currentIndex(panel)).toBe(index);
        expect(await panel.evaluate(el => el.playing)).toBe(false);
    });

    test('without loop, autoplay pauses on the last slide and play() starts over', async ({page}) => {
        const panel = await mount(page, '<image-panel autoplay loop="false" interval="100" transition-duration="0"></image-panel>');
        await record(panel, 'pause');
        await setConfig(panel, IMAGES);

        await expect.poll(() => events(page)).toHaveLength(1);
        expect(await currentIndex(panel)).toBe(2);
        expect(await panel.evaluate(el => el.playing)).toBe(false);

        await panel.evaluate(el => el.play());
        await expect.poll(() => currentIndex(panel)).toBe(0);
    });

    test('without loop, a failing last image ends playback on the slide before', async ({page}) => {
        const panel = await mount(page, '<image-panel autoplay loop="false" interval="100" transition-duration="0"></image-panel>');
        await record(panel, 'pause', 'error');
        await setConfig(panel, [IMAGES[0], IMAGES[1], '/missing.jpg']);

        await expect.poll(() => events(page)).toHaveLength(1);
        expect((await events(page))[0].type).toBe('pause');
        expect(await currentIndex(panel)).toBe(1);
    });

    test('manual navigation restarts the countdown instead of adding a second timer', async ({page}) => {
        const panel = await mount(page, '<image-panel autoplay interval="400" transition-duration="0"></image-panel>');
        await record(panel, 'slidechange');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await page.waitForTimeout(200);
        await panel.evaluate(el => el.next());
        await page.waitForTimeout(300);
        // 500ms after start, with a fresh 400ms countdown from the manual next at 200ms
        expect(await currentIndex(panel)).toBe(1);
        await expect.poll(() => currentIndex(panel)).toBe(2);
    });

    test('holds while the document is hidden', async ({page}) => {
        const panel = await mount(page, '<image-panel autoplay interval="150" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(400);
        expect(await currentIndex(panel)).toBe(0);

        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect.poll(() => currentIndex(panel)).toBe(1);
    });

    test('pauses on hover only when pause-on-hover is set', async ({page}) => {
        const panel = await mount(page, '<image-panel autoplay pause-on-hover interval="150" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await page.mouse.move(600, 600);
        await panel.hover();
        const index = await currentIndex(panel);
        await page.waitForTimeout(400);
        expect(await currentIndex(panel)).toBe(index);

        await page.mouse.move(600, 600);
        await expect.poll(() => currentIndex(panel)).not.toBe(index);
    });
});


test.describe('events', () => {
    test('config and image loading', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await record(panel, 'configloadstart', 'ready', 'slideloadstart', 'slideload', 'slidechange');
        await panel.evaluate(el => el.src = '/tests/config.json');
        await expect.poll(async () => (await events(page)).filter(e => e.type === 'slideload').length).toBe(2);

        const log = (await events(page)).map(e => [e.type, e.detail.index ?? e.detail.length ?? e.detail.url, e.detail.preload, e.detail.trigger]);
        expect(log).toEqual([
            ['configloadstart', expect.stringMatching(/\/tests\/config\.json$/), undefined, 'api'],
            ['ready', 3, undefined, 'api'],
            ['slideloadstart', 0, false, 'start'],
            ['slideload', 0, undefined, 'start'],
            ['slidechange', 0, undefined, 'start'],
            ['slideloadstart', 1, true, 'auto'],
            ['slideload', 1, undefined, 'auto'],
        ]);
    });

    test('navigation lifecycle, with triggers and loop', async ({page}) => {
        const panel = await mount(page, '<image-panel keyboard transition-duration="0"></image-panel>');
        await record(panel, 'navigate', 'loop', 'slidechange', 'slidechangeend');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await panel.focus();
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => currentIndex(panel)).toBe(2);

        const log = (await events(page)).map(e => [e.type, e.detail.previousIndex, e.detail.index, e.detail.trigger]);
        expect(log).toEqual([
            ['navigate', -1, 0, 'start'],
            ['slidechange', -1, 0, 'start'],
            ['slidechangeend', -1, 0, 'start'],
            ['navigate', 0, 2, 'keyboard'],
            ['loop', 0, 2, 'keyboard'],
            ['slidechange', 0, 2, 'keyboard'],
            ['slidechangeend', 0, 2, 'keyboard'],
        ]);
    });

    test('playback: play, countdown, hold, resume, pause and ended', async ({page}) => {
        const panel = await mount(page, '<image-panel loop="false" interval="100" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await record(panel, 'play', 'pause', 'ended', 'hold', 'resume', 'countdown');

        await panel.evaluate(el => {
            el.play();
            el.dispatchEvent(new FocusEvent('focusin'));
            el.dispatchEvent(new FocusEvent('focusout'));
        });
        await expect.poll(async () => (await events(page)).some(e => e.type === 'ended')).toBe(true);

        const log = (await events(page)).map(e => [e.type, e.detail.trigger]);
        expect(log).toEqual([
            ['play', 'api'],
            ['countdown', 'api'],
            ['hold', 'focus'],
            ['resume', 'focus'],
            ['countdown', 'focus'],
            ['countdown', 'auto'],
            // The last slide gets its full interval before playback ends
            ['countdown', 'auto'],
            ['pause', 'auto'],
            ['ended', 'auto'],
        ]);
    });
});


test.describe('errors', () => {
    test('skips images that fail to load', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        await record(panel, 'slideerror', 'slidechange');
        await setConfig(panel, ['/missing.jpg', IMAGES[1]]);

        await expect.poll(() => currentIndex(panel)).toBe(1);
        expect((await events(page)).map(e => e.type)).toEqual(['slideerror', 'slidechange']);
    });

    test('gives up when every image fails, without looping', async ({page}) => {
        let requests = 0;
        page.on('request', request => request.url().includes('missing') && requests++);

        const panel = await mount(page, '<image-panel autoplay interval="50" transition-duration="0"></image-panel>');
        await record(panel, 'error');
        await setConfig(panel, ['/missing-1.jpg', '/missing-2.jpg']);

        await expect.poll(() => events(page)).toHaveLength(1);
        await page.waitForTimeout(300);
        expect(requests).toBe(2);
    });
});


test.describe('metadata', () => {
    // Markermeer.jpg with its own metadata removed, so each test can add its own
    const PLAIN_JPEG = (() => {
        const file = readFileSync(new URL('../demo/images/Markermeer.jpg', import.meta.url));
        const kept = [file.subarray(0, 2)];
        let i = 2;
        while (file[i + 1] !== 0xDA)
        {
            const end = i + 2 + file.readUInt16BE(i + 2);
            if (file[i + 1] !== 0xE1 && file[i + 1] !== 0xED) kept.push(file.subarray(i, end));
            i = end;
        }
        return Buffer.concat([...kept, file.subarray(i)]);
    })();

    const segment = (marker, ...parts) => {
        const payload = Buffer.concat(parts);
        const header = Buffer.from([0xFF, marker, 0, 0]);
        header.writeUInt16BE(payload.length + 2, 2);
        return Buffer.concat([header, payload]);
    };
    const jpeg = (...segments) => Buffer.concat([PLAIN_JPEG.subarray(0, 2), ...segments, PLAIN_JPEG.subarray(2)]);

    const xmpPacket = (properties, attributes = '') => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
                xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
                xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" ${attributes}>${properties}</rdf:Description>
        </rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const xmp = (...args) => segment(0xE1, Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xmpPacket(...args)));

    /** A TIFF block of ASCII tags, as found in a JPEG's APP1 or a PNG's eXIf. */
    const tiff = tags => {
        const entries = Object.entries(tags);
        const ifd = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
        const values = [];
        let offset = ifd.length;
        ifd.write('II');
        ifd.writeUInt16LE(42, 2);
        ifd.writeUInt32LE(8, 4);
        ifd.writeUInt16LE(entries.length, 8);
        entries.forEach(([tag, text], i) => {
            const value = Buffer.from(`${text}\0`);
            const entry = 10 + i * 12;
            ifd.writeUInt16LE(Number(tag), entry);
            ifd.writeUInt16LE(2, entry + 2);
            ifd.writeUInt32LE(value.length, entry + 4);
            // Values of up to four bytes are stored in the entry itself
            if (value.length <= 4)
            {
                value.copy(ifd, entry + 8);
                return;
            }
            ifd.writeUInt32LE(offset, entry + 8);
            values.push(value);
            offset += value.length;
        });
        return Buffer.concat([ifd, ...values]);
    };
    const exif = tags => segment(0xE1, Buffer.from('Exif\0\0'), tiff(tags));

    /** IPTC record 2 datasets, as [dataset, text, encoding]. */
    const iptc = (...datasets) => {
        const iim = Buffer.concat(datasets.flatMap(([dataset, text, encoding = 'utf8']) => {
            const value = Buffer.from(text, encoding);
            return [Buffer.from([0x1C, 2, dataset, value.length >> 8, value.length & 0xFF]), value];
        }));
        const resource = Buffer.alloc(12);
        resource.write('8BIM');
        resource.writeUInt16BE(0x0404, 4);
        resource.writeUInt32BE(iim.length, 8);
        return segment(0xED, Buffer.from('Photoshop 3.0\0'), resource, iim, Buffer.alloc(iim.length % 2));
    };

    /** A 1×1 PNG with the given ancillary chunks before its image data. */
    const png = (...chunks) => {
        const chunk = (type, data) => {
            const head = Buffer.alloc(8);
            head.writeUInt32BE(data.length);
            head.write(type, 4);
            const crc = Buffer.alloc(4);
            crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
            return Buffer.concat([head, data, crc]);
        };
        const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', header),
            ...chunks.map(([type, data]) => chunk(type, data)),
            chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
            chunk('IEND', Buffer.alloc(0)),
        ]);
    };

    async function serve(page, files)
    {
        const requests = [];
        await page.route('**/meta/*', route => {
            const name = new URL(route.request().url()).pathname.split('/').pop();
            requests.push(route.request().resourceType());
            return route.fulfill({body: files[name], contentType: name.endsWith('.png') ? 'image/png' : 'image/jpeg'});
        });
        return requests;
    }

    const loaded = (panel, index = 0) => panel.evaluate((el, i) => new Promise(resolve => {
        el.addEventListener('slideload', function listener({detail})
        {
            if (detail.index !== i) return;
            el.removeEventListener('slideload', listener);
            resolve(JSON.parse(JSON.stringify(detail.slide)));
        });
    }), index);

    test('reads XMP fields, choosing the language alternative that matches the page', async ({page}) => {
        await serve(page, {'lake.jpg': jpeg(xmp(`
            <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Lake</rdf:li><rdf:li xml:lang="de">See</rdf:li></rdf:Alt></dc:title>
            <dc:description><rdf:Alt><rdf:li xml:lang="x-default">A lone sail on a grey lake.</rdf:li></rdf:Alt></dc:description>
            <dc:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Grace</rdf:li></rdf:Seq></dc:creator>
            <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Ada Shailer</rdf:li></rdf:Alt></dc:rights>
            <Iptc4xmpCore:AltTextAccessibility><rdf:Alt><rdf:li xml:lang="x-default">A white sail beneath storm clouds.</rdf:li></rdf:Alt></Iptc4xmpCore:AltTextAccessibility>`))});

        const panel = await mount(page, '<div lang="de-CH"><image-panel metadata transition-duration="0"></image-panel></div>');
        const slide = loaded(panel);
        await setConfig(panel, ['/meta/lake.jpg']);

        expect(await slide).toMatchObject({
            title: 'See',
            description: 'A lone sail on a grey lake.',
            alt: 'A white sail beneath storm clouds.',
            creator: 'Ada, Grace',
            copyright: '© Ada Shailer',
        });
        await expect(panel.locator('img')).toHaveAttribute('alt', 'A white sail beneath storm clouds.');
    });

    test('fields set on the slide win over the file', async ({page}) => {
        await serve(page, {'lake.jpg': jpeg(xmp(`
            <dc:title><rdf:Alt><rdf:li xml:lang="x-default">File title</rdf:li></rdf:Alt></dc:title>
            <dc:description><rdf:Alt><rdf:li xml:lang="x-default">File description</rdf:li></rdf:Alt></dc:description>
            <Iptc4xmpCore:AltTextAccessibility><rdf:Alt><rdf:li xml:lang="x-default">File alt</rdf:li></rdf:Alt></Iptc4xmpCore:AltTextAccessibility>`))});

        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        const slide = loaded(panel);
        await setConfig(panel, {metadata: true, slides: [{src: '/meta/lake.jpg', title: 'My title', alt: ''}]});

        // An empty alt still means decorative
        expect(await slide).toMatchObject({title: 'My title', description: 'File description', alt: ''});
        await expect(panel.locator('img')).toHaveAttribute('alt', '');
    });

    test('falls back from XMP to IPTC to EXIF, and skips camera placeholders', async ({page}) => {
        await serve(page, {
            'iptc.jpg': jpeg(
                exif({0x010E: 'OLYMPUS DIGITAL CAMERA', 0x013B: 'Exif artist', 0x8298: 'Photographer\0Editor'}),
                iptc([5, 'Café'], [120, 'Résumé', 'latin1'], [80, 'Ada'], [80, 'Grace']),
                // Simple XMP properties are often written as attributes
                xmp('', 'photoshop:Headline="Headline"'),
            ),
            'exif.jpg': jpeg(
                exif({0x010E: 'Exif description', 0x8298: 'Photographer\0Editor'}),
                xmp('', 'photoshop:Headline="Headline"'),
            ),
        });

        const panel = await mount(page, '<image-panel metadata transition-duration="0"></image-panel>');
        const first = loaded(panel, 0);
        const second = loaded(panel, 1);
        await setConfig(panel, ['/meta/iptc.jpg', '/meta/exif.jpg']);

        expect(await first).toMatchObject({title: 'Café', description: 'Résumé', creator: 'Ada, Grace', copyright: 'Photographer, Editor'});
        expect(await second).toMatchObject({title: 'Headline', description: 'Exif description', copyright: 'Photographer, Editor', alt: 'Headline'});
    });

    test('reads XMP and EXIF from PNGs', async ({page}) => {
        const itxt = Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0'), Buffer.from(xmpPacket(
            '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Pixel</rdf:li></rdf:Alt></dc:title>'))]);
        await serve(page, {'pixel.png': png(['iTXt', itxt], ['eXIf', tiff({0x013B: 'Ada'})])});

        const panel = await mount(page, '<image-panel metadata transition-duration="0"></image-panel>');
        const slide = loaded(panel);
        await setConfig(panel, ['/meta/pixel.png']);
        expect(await slide).toMatchObject({title: 'Pixel', alt: 'Pixel', creator: 'Ada'});
    });

    test('fills in child images without their own alt', async ({page}) => {
        await serve(page, {'lake.jpg': jpeg(iptc([5, 'Lake']))});
        const panel = await mount(page, `
            <image-panel metadata transition-duration="0">
                <img src="/meta/lake.jpg">
                <img src="/meta/lake.jpg?decorative" alt="">
            </image-panel>`, {define: false});
        const first = loaded(panel, 0);
        const second = loaded(panel, 1);
        await page.addScriptTag({type: 'module', url: '/src/image-panel.js'});

        expect(await first).toMatchObject({title: 'Lake', alt: 'Lake'});
        expect(await second).toMatchObject({title: 'Lake', alt: ''});
    });

    test('is off by default', async ({page}) => {
        const requests = await serve(page, {'lake.jpg': jpeg(iptc([5, 'Lake']))});
        const panel = await mount(page, '<image-panel transition-duration="0"></image-panel>');
        const slide = loaded(panel);
        await setConfig(panel, ['/meta/lake.jpg']);

        expect((await slide).title).toBeUndefined();
        expect(requests).toEqual(['image']);
    });

    test('still shows the slide when the metadata cannot be read', async ({page}) => {
        // As for a cross-origin image without CORS: the <img> loads, but fetch fails
        await page.route('**/meta/*', route => route.request().resourceType() === 'image'
            ? route.fulfill({body: jpeg(iptc([5, 'Lake'])), contentType: 'image/jpeg'})
            : route.fulfill({status: 404}));
        const warnings = [];
        page.on('console', message => message.type() === 'warning' && warnings.push(message.text()));

        const panel = await mount(page, '<image-panel metadata transition-duration="0"></image-panel>');
        const slide = loaded(panel);
        await setConfig(panel, ['/meta/lake.jpg']);

        expect(await slide).toMatchObject({alt: ''});
        await expect(panel.locator('img')).toHaveCount(1);
        expect(warnings).toEqual([expect.stringContaining('Failed to read metadata')]);
    });
});


test.describe('accessibility', () => {
    test('exposes a labelled carousel group with image alt text', async ({page, browserName}) => {
        // Playwright's role queries don't see ElementInternals, so read the browser's own accessibility tree
        test.skip(browserName !== 'chromium', 'Uses the Chrome DevTools Protocol');

        const panel = await mount(page, '<image-panel aria-label="Holiday photos" transition-duration="0"></image-panel>');
        await setConfig(panel, [{src: IMAGES[0], title: 'Markermeer'}]);
        await expect(panel.locator('img')).toHaveCount(1);

        const cdp = await page.context().newCDPSession(page);
        const {nodes} = await cdp.send('Accessibility.getFullAXTree');
        const group = nodes.find(node => node.name?.value === 'Holiday photos');
        const roledescription = group.properties.find(prop => prop.name === 'roledescription');

        expect(group.role.value).toBe('group');
        expect(roledescription.value.value).toBe('carousel');
        expect(nodes.some(node => node.role.value === 'image' && node.name?.value === 'Markermeer')).toBe(true);
    });

    test('has no built-in UI, and flags auto-advanced changes', async ({page}) => {
        const panel = await mount(page, '<image-panel transition-duration="0" interval="100000"></image-panel>');
        await setConfig(panel, [{src: IMAGES[0]}, {src: IMAGES[1]}]);
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await expect(panel.locator('[aria-live]')).toHaveCount(0);

        await record(panel, 'slidechange');
        await panel.evaluate(el => el.next());
        await expect.poll(() => currentIndex(panel)).toBe(1);
        await panel.evaluate(el => { el.interval = 50; el.play(); });
        await expect.poll(() => currentIndex(panel)).toBe(0);
        await panel.evaluate(el => el.pause());

        expect((await events(page)).slice(0, 2).map(e => e.detail.trigger)).toEqual(['api', 'auto']);
    });

    test('skips the fade when reduced motion is preferred', async ({page}) => {
        await page.emulateMedia({reducedMotion: 'reduce'});
        const panel = await mount(page, '<image-panel transition-duration="5000"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect.poll(() => currentIndex(panel)).toBe(0);

        await panel.evaluate(el => el.next());
        await expect.poll(() => currentIndex(panel)).toBe(1);
        await expect(panel.locator('.slide')).toHaveCount(1);
    });

    test('ignores motion when reduced motion is preferred', async ({page}) => {
        await page.emulateMedia({reducedMotion: 'reduce'});
        const panel = await mount(page, '<image-panel autoplay></image-panel>');
        await setConfig(panel, {motion: ['scale(1)', 'scale(1.2)'], slides: IMAGES});
        await expect(panel.locator('.slide')).toHaveCount(1);
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.slide').getAnimations({subtree: true}).length)).toBe(0);
    });
});


test('demo page runs from the built dist file', async ({page}) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error));
    page.on('console', message => message.type() === 'warning' && errors.push(message.text()));

    await page.goto('/demo/');
    await expect(page.locator('#main img')).toHaveCount(1);
    await expect(page.locator('#title')).toHaveText('Boat stall in Hạ Long Bay');
    await page.locator('#next').click();
    await expect(page.locator('#counter')).toHaveText('2 / 5');
    // Read from the image's metadata
    await expect(page.locator('#title')).toHaveText('Khải Định');
    await expect(page.locator('#credit')).toHaveText('Photo: Adam Shailer');
    expect(errors).toEqual([]);
});
