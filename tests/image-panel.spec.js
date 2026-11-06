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
 * Steps through the newest slide's motion and returns how far the panel's corners fall outside the image
 * at worst, as a fraction of the panel: 0 or less means it covers throughout.
 */
const motionShortfall = panel => panel.evaluate(el => {
    const slide = el.shadowRoot.querySelector('.slide:last-child');
    const img = slide.querySelector('img');
    const anims = [...slide.getAnimations(), ...img.getAnimations()].filter(a => a.id.startsWith('motion'));
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
        const inverse = new DOMMatrix(getComputedStyle(slide).transform).scale(scale).inverse();
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
            const anim = el.shadowRoot.querySelector('.slide').getAnimations().find(a => a.id === 'motion');
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

        const motions = () => panel.evaluate(el => el.shadowRoot.querySelector('.slide').getAnimations().filter(a => a.id === 'motion').length);
        await expect(panel.locator('.slide')).toHaveCount(1);
        expect(await motions()).toBe(1);
        // Not playing, so it stays put
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.slide').getAnimations()[0].playState)).toBe('paused');

        await panel.evaluate(el => el.next());
        await expect.poll(() => currentIndex(panel)).toBe(1);
        expect(await motions()).toBe(0);
    });

    test('random motion, from the attribute, config or property', async ({page}) => {
        const panel = await mount(page, '<image-panel motion="random" transition-duration="0"></image-panel>');
        await setConfig(panel, IMAGES);
        await expect(panel.locator('.slide')).toHaveCount(1);

        const frames = () => panel.evaluate(el => el.shadowRoot.querySelector('.slide:last-child').getAnimations()
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
            const motion = slide.getAnimations().find(a => a.id === 'motion');
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
        expect(await panel.evaluate(el => el.shadowRoot.querySelector('.slide').getAnimations().length)).toBe(0);
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
