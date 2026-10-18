import {test, expect} from '@playwright/test';

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
    expect(errors).toEqual([]);
});
