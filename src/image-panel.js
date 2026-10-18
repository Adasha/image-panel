/*!
 * <image-panel> web component
 * https://github.com/Adasha/image-panel
 * @license MPL-2.0
 */

import {readMetadata} from './metadata.js';

const DEFAULT_INTERVAL = 6000;
const DEFAULT_TRANSITION = 1000;

const FLIPS = {
    horizontal: 'scaleX(-1)',
    vertical: 'scaleY(-1)',
    both: 'scale(-1, -1)',
};

const KEYS = {
    ArrowLeft: (panel, rtl) => ({step: rtl ? 1 : -1}),
    ArrowRight: (panel, rtl) => ({step: rtl ? -1 : 1}),
    Home: () => ({index: 0}),
    End: panel => ({index: panel.length - 1}),
};

const UPGRADABLE = [
    'metadata', 'src', 'config', 'interval', 'transitionDuration', 'autoplay', 'shuffle', 'loop',
    'startIndex', 'fit', 'position', 'sizes', 'motion', 'keyboard', 'pauseOnHover',
];

const template = document.createElement('template');
template.innerHTML = `
<style>
    :host {
        display: block;
        position: relative;
        height: 100%;
        overflow: hidden;
        contain: layout paint;
    }
    :host([hidden]) {
        display: none;
    }
    .slides, .slide, img {
        position: absolute;
        inset: 0;
    }
    .slides {
        isolation: isolate;
    }
    .slide {
        /* Opacities add rather than layer, so a cross-fade stays solid where slides overlap */
        mix-blend-mode: plus-lighter;
    }
    img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: var(--image-panel-fit, cover);
        object-position: var(--image-panel-position, center);
    }
</style>
<div class="slides"></div>
`;


/**
 * Minimal, configurable image viewer.
 *
 * Every event's detail has a `trigger` saying what caused it:
 * 'start' | 'auto' | 'keyboard' | 'api', or for hold/resume 'focus' | 'hover' | 'hidden' | 'offscreen'.
 *
 * @fires configloadstart - Fetching the `src` JSON. detail: { url }
 * @fires ready           - Slides are known and about to start showing. detail: { length }
 * @fires error           - The config failed to load, or no slide could be shown. detail: { error }
 * @fires slideloadstart  - An image started loading. detail: { index, slide, preload }
 * @fires slideload       - An image loaded and decoded. detail: { index, slide }
 * @fires slideerror      - An image failed to load and will be skipped. detail: { index, slide }
 * @fires navigate        - Heading for a new slide, before it loads. detail: { index, previousIndex, trigger }
 * @fires loop            - Navigation wrapped round an end. detail: { index, previousIndex, trigger }
 * @fires slidechange     - A new slide starts to show. detail: { index, previousIndex, slide, trigger }
 * @fires slidechangeend  - The new slide has finished transitioning in. Not fired if a later slide interrupts it. detail: as slidechange
 * @fires play            - Auto-advance turned on.
 * @fires pause           - Auto-advance turned off.
 * @fires ended           - Auto-advance stopped on the last slide (without loop).
 * @fires hold            - Auto-advance temporarily held while playing.
 * @fires resume          - The last hold was released while playing.
 * @fires countdown       - The auto-advance timer started or restarted. detail: { remaining, interval }
 *
 * @csspart slide - Wrapper around each slide; this is what fades and moves.
 * @csspart image - The <img> inside each slide.
 *
 * @cssprop --image-panel-fit      - Default object-fit (cover).
 * @cssprop --image-panel-position - Default object-position (center).
 */
export class ImagePanel extends HTMLElement
{
    static observedAttributes = ['src', 'interval', 'keyboard'];

    #internals = this.attachInternals();
    #root = this.attachShadow({mode: 'open'});
    #stage;

    #source = null;         // 'src' | 'config' | 'children'
    #config = {};
    #slides = [];
    #failed = new Set();
    #index = -1;
    #target = -1;           // slide being loaded, or the current one
    #navId = 0;
    #busy = false;
    #anim = null;
    #preload = null;
    #request = null;
    #motion;                // non-string `motion` set from JS
    #described = new WeakMap(); // slide -> promise of its fields being filled in

    #playing = false;
    #holds = new Set(['offscreen']);
    #timer = 0;
    #timerStart = 0;
    #remaining = null;

    #ownTabindex = false;
    #intersection = new IntersectionObserver(([entry]) => this.#setHold('offscreen', !entry.isIntersecting), {rootMargin: '200px'});
    #mutation = new MutationObserver(() => (!this.#source || this.#source === 'children') && this.#readChildren());


    constructor()
    {
        super();

        this.#root.append(template.content.cloneNode(true));
        this.#stage = this.#root.querySelector('.slides');

        this.#internals.role = 'group';
        this.#internals.ariaRoleDescription = 'carousel';

        this.addEventListener('keydown', this.#onKeydown);
        this.addEventListener('focusin', () => this.#setHold('focus', true));
        this.addEventListener('focusout', () => this.#setHold('focus', false));
        this.addEventListener('pointerenter', () => this.pauseOnHover && this.#setHold('hover', true));
        this.addEventListener('pointerleave', () => this.#setHold('hover', false));
    }

    connectedCallback()
    {
        for (const prop of UPGRADABLE)
        {
            this.#upgradeProperty(prop);
        }

        document.addEventListener('visibilitychange', this.#onVisibilityChange);
        this.#onVisibilityChange();
        this.#intersection.observe(this);
        this.#mutation.observe(this, {childList: true});
        this.#syncTabindex();

        if (!this.#source || this.#source === 'children')
        {
            this.#readChildren();
        }
    }

    disconnectedCallback()
    {
        document.removeEventListener('visibilitychange', this.#onVisibilityChange);
        this.#intersection.disconnect();
        this.#mutation.disconnect();
        this.#setHold('offscreen', true);
    }

    attributeChangedCallback(name, oldValue, newValue)
    {
        switch (name)
        {
            case 'src':
                if (newValue)
                {
                    this.#source = 'src';
                    this.#fetchConfig(newValue);
                }
                else if (this.#source === 'src')
                {
                    this.#request?.abort();
                    this.#source = 'children';
                    this.#readChildren();
                }
                break;

            case 'interval':
                // Restart a running countdown with the new interval
                if (this.#remaining !== null)
                {
                    this.#clearTimer();
                    this.#remaining = this.interval;
                    this.#tick('api');
                }
                break;

            case 'keyboard':
                this.#syncTabindex();
                break;
        }
    }



    // Public API

    /** Start auto-advancing. */
    play()
    {
        this.#play('api');
    }

    /** Stop auto-advancing. The current slide stays visible. */
    pause()
    {
        this.#pause('api');
    }

    /** Show the next slide, wrapping round at the end if `loop` is on. */
    next()
    {
        this.#step(1, 'api');
    }

    /** Show the previous slide, wrapping round at the start if `loop` is on. */
    prev()
    {
        this.#step(-1, 'api');
    }

    /** Show the slide at the given index. Out-of-range indexes wrap if `loop` is on, and are ignored otherwise. */
    goTo(index)
    {
        this.#goTo(index, 'api');
    }

    get currentIndex() { return this.#index; }
    get currentSlide() { return this.#slides[this.#index] ?? null; }
    get length() { return this.#slides.length; }
    get playing() { return this.#playing; }
    get slides() { return [...this.#slides]; }

    /** URL of a JSON config file. */
    get src() { return this.getAttribute('src') ?? ''; }
    set src(url) { this.setAttribute('src', url); }

    /** A config object (same shape as the JSON file) or an array of slides. */
    get config() { return this.#config; }
    set config(value)
    {
        this.#request?.abort();
        this.#source = 'config';
        this.#apply(value ?? [], document.baseURI);
    }

    /** Milliseconds each slide is shown for, not counting the transition. */
    get interval() { return toNumber(this.getAttribute('interval')) ?? toNumber(this.#config.interval) ?? DEFAULT_INTERVAL; }
    set interval(ms) { this.setAttribute('interval', ms); }

    /** Cross-fade duration in milliseconds. 0 for a hard cut. Ignored when the user prefers reduced motion. */
    get transitionDuration() { return toNumber(this.getAttribute('transition-duration')) ?? toNumber(this.#config.transitionDuration) ?? DEFAULT_TRANSITION; }
    set transitionDuration(ms) { this.setAttribute('transition-duration', ms); }

    get autoplay() { return this.hasAttribute('autoplay') || !!this.#config.autoplay; }
    set autoplay(value) { this.toggleAttribute('autoplay', !!value); }

    get shuffle() { return this.hasAttribute('shuffle') || !!this.#config.shuffle; }
    set shuffle(value) { this.toggleAttribute('shuffle', !!value); }

    /** Wrap round from the last slide to the first, and back. On unless set to `"false"`. */
    get loop()
    {
        const attr = this.getAttribute('loop');
        return attr === null ? this.#config.loop !== false : attr !== 'false';
    }
    set loop(value) { this.setAttribute('loop', String(!!value)); }

    get startIndex() { return toNumber(this.getAttribute('start-index')) ?? toNumber(this.#config.startIndex) ?? 0; }
    set startIndex(index) { this.setAttribute('start-index', index); }

    /** Default object-fit for slides. */
    get fit() { return this.getAttribute('fit') ?? this.#config.fit ?? ''; }
    set fit(value) { this.setAttribute('fit', value); }

    /** Default object-position for slides. */
    get position() { return this.getAttribute('position') ?? this.#config.position ?? ''; }
    set position(value) { this.setAttribute('position', value); }

    /** Default `sizes` for slides with a srcset. Defaults to the panel's rendered width. */
    get sizes() { return this.getAttribute('sizes') ?? this.#config.sizes ?? ''; }
    set sizes(value) { this.setAttribute('sizes', value); }

    /**
     * Default motion for slides without their own: `'random'`, `'none'`, or a motion spec
     * (an array of transforms, or `{from, to, easing}`). Strings are reflected to the attribute.
     * Takes effect from the next slide.
     */
    get motion() { return this.#motion ?? this.getAttribute('motion') ?? this.#config.motion ?? null; }
    set motion(value)
    {
        if (typeof value === 'string')
        {
            this.#motion = undefined;
            this.setAttribute('motion', value);
        }
        else
        {
            this.#motion = value ?? undefined;
            this.removeAttribute('motion');
        }
    }

    /**
     * Fill in each slide's missing `title`, `description`, `alt`, `creator` and `copyright` from its image file's
     * metadata, when the slide first loads. Takes effect from the next config.
     */
    get metadata() { return this.hasAttribute('metadata') || !!this.#config.metadata; }
    set metadata(value) { this.toggleAttribute('metadata', !!value); }

    /** Enable arrow key, Home and End navigation. Makes the panel focusable. */
    get keyboard() { return this.hasAttribute('keyboard'); }
    set keyboard(value) { this.toggleAttribute('keyboard', !!value); }

    get pauseOnHover() { return this.hasAttribute('pause-on-hover'); }
    set pauseOnHover(value) { this.toggleAttribute('pause-on-hover', !!value); }



    // Loading

    async #fetchConfig(url)
    {
        this.#request?.abort();
        const request = this.#request = new AbortController();
        this.#emit('configloadstart', 'api', {url: new URL(url, document.baseURI).href});

        try
        {
            const response = await fetch(url, {signal: request.signal});
            if (!response.ok)
            {
                throw new Error(`HTTP ${response.status} loading ${response.url}`);
            }
            const data = await response.json();
            if (!request.signal.aborted)
            {
                this.#apply(data, response.url);
            }
        }
        catch (error)
        {
            if (error.name !== 'AbortError')
            {
                this.#fail(error, 'api');
            }
        }
        finally
        {
            if (this.#request === request) this.#request = null;
        }
    }

    #readChildren()
    {
        const images = this.querySelectorAll(':scope > img');
        if (!images.length && !this.#source) return;

        this.#source = 'children';
        this.#apply([...images].map(img => ({
            src: img.getAttribute('src'),
            srcset: img.getAttribute('srcset'),
            sizes: img.getAttribute('sizes'),
            alt: img.getAttribute('alt'),
            title: img.getAttribute('title'),
            ...img.dataset,
        })), document.baseURI);
    }

    #apply(data, baseURL)
    {
        const config = Array.isArray(data) ? {slides: data} : {...data};
        const base = new URL(config.basePath ?? '', baseURL);

        this.#config = config;
        this.#slides = (Array.isArray(config.slides) ? config.slides : [])
            .map(slide => normaliseSlide(slide, base))
            .filter(Boolean);

        // Without metadata to wait for, slides are complete straight away
        if (!this.metadata)
        {
            this.#slides.forEach(slide => this.#describe(slide));
        }
        if (this.shuffle)
        {
            shuffle(this.#slides);
        }
        if (!this.#slides.length)
        {
            this.#stage.replaceChildren();
        }

        // Reset playback state; the old slide stays on screen until the new one fades in over it
        this.#navId++;
        this.#busy = false;
        this.#index = -1;
        this.#target = -1;
        this.#failed.clear();
        this.#preload = null;
        this.#clearTimer();
        this.#remaining = null;

        this.#emit('ready', 'api', {length: this.#slides.length});
        this.#start();
    }

    #start()
    {
        if (this.#index >= 0 || this.#busy || !this.#slides.length || this.#holds.has('offscreen')) return;

        if (this.autoplay)
        {
            this.#play('start');
        }
        this.#show(this.startIndex, 1, 'start');
    }

    #createImage(index, priority, trigger)
    {
        const slide = this.#slides[index];
        const img = document.createElement('img');

        img.setAttribute('part', 'image');
        img.decoding = 'async';
        img.fetchPriority = priority;

        if (slide.style)
        {
            img.style.cssText = slide.style;
        }
        const fit = slide.fit || this.fit;
        const position = slide.position || this.position;
        const transform = [slide.transform, FLIPS[slide.flip]].filter(Boolean).join(' ');
        if (fit) img.style.objectFit = fit;
        if (position) img.style.objectPosition = position;
        if (transform) img.style.transform = transform;
        if (slide.clip) img.style.clipPath = slide.clip;

        // srcset and sizes must be set before src to avoid a wasted request
        if (slide.srcset)
        {
            img.sizes = slide.sizes || this.sizes || this.#renderedSizes();
            img.srcset = slide.srcset;
        }
        img.src = slide.src;

        const slides = this.#slides;
        const ready = Promise.all([
            img.decode().then(
                () => img,
                // decode() can reject for reasons other than a broken image
                () => img.complete && img.naturalWidth ? img : null,
            ),
            this.#describe(slide, priority),
        ]).then(([img]) => {
            if (img) img.alt = slide.alt;
            // Ignore images from a slide list that has since been replaced
            if (this.#slides !== slides) return img;
            if (img)
            {
                this.#emit('slideload', trigger, {index, slide});
            }
            else
            {
                this.#failed.add(index);
                console.warn(`[image-panel] Failed to load "${slide.src}"`);
                this.#emit('slideerror', trigger, {index, slide});
            }
            return img;
        });
        this.#emit('slideloadstart', trigger, {index, slide, preload: priority === 'low'});
        return {index, ready};
    }

    /** Fills in the slide's missing fields, from its image's metadata if enabled. Once per slide. */
    #describe(slide, priority)
    {
        let described = this.#described.get(slide);
        if (!described)
        {
            if (this.metadata)
            {
                described = readMetadata(slide.src, {priority, lang: this.closest('[lang]')?.lang}).then(
                    fields => completeSlide(slide, fields),
                    error => {
                        console.warn(`[image-panel] Failed to read metadata from "${slide.src}"`, error);
                        completeSlide(slide);
                    },
                );
            }
            else
            {
                completeSlide(slide);
                described = Promise.resolve();
            }
            this.#described.set(slide, described);
        }
        return described;
    }

    #renderedSizes()
    {
        const width = Math.ceil(this.getBoundingClientRect().width);
        return width ? `${width}px` : '100vw';
    }

    #preloadFrom(index)
    {
        const next = this.#nextLoadable(index, 1);
        if (next === -1 || next === this.#index || this.#preload?.index === next) return;
        this.#preload = this.#createImage(next, 'low', 'auto');
    }

    #nextLoadable(index, step, wrap = this.loop)
    {
        return this.#findLoadable(index, step, wrap)?.index ?? -1;
    }

    /** The first slide from `index` that hasn't failed, and whether reaching it crossed an end. */
    #findLoadable(index, step, wrap)
    {
        const length = this.#slides.length;
        for (let tries = 0; tries < length; tries++, index += step)
        {
            const outside = index < 0 || index >= length;
            if (!wrap && outside) break;
            const wrapped = ((index % length) + length) % length;
            if (!this.#failed.has(wrapped)) return {index: wrapped, wrapped: outside};
        }
        return null;
    }

    /** True when showing the last loadable slide and not looping. */
    #atEnd()
    {
        return this.#index >= 0 && !this.#busy && !this.loop && this.#nextLoadable(this.#index + 1, 1) === -1;
    }



    // Display

    #step(step, trigger)
    {
        // Without looping, stepping off either end does nothing
        if (!this.loop && this.#nextLoadable(this.#target + step, step) === -1) return;
        this.#show(this.#target + step, step, trigger);
    }

    #goTo(index, trigger)
    {
        index = Math.trunc(Number(index));
        if (!Number.isFinite(index) || (index === this.#index && !this.#busy)) return;
        if (!this.loop && (index < 0 || index >= this.#slides.length)) return;
        this.#show(index, 1, trigger);
    }

    async #show(index, step, trigger)
    {
        if (!this.#slides.length) return;

        // The first slide may wrap round to find one that loads, even without looping
        const wrap = this.loop || this.#index < 0;
        const navId = ++this.#navId;
        this.#busy = true;
        this.#clearTimer();
        this.#remaining = null;

        const first = this.#nextLoadable(index, step, wrap);
        if (first !== -1)
        {
            this.#emit('navigate', trigger, {index: first, previousIndex: this.#index});
            if (navId !== this.#navId) return;
        }

        let found, looped = false;
        while ((found = this.#findLoadable(index, step, wrap)))
        {
            const target = this.#target = found.index;
            looped ||= found.wrapped;
            const pending = this.#preload?.index === target
                ? this.#preload
                : this.#createImage(target, this.#index < 0 ? 'high' : 'auto', trigger);
            this.#preload = null;

            const img = await pending.ready;
            if (navId !== this.#navId) return;

            if (img)
            {
                return this.#reveal(img, target, navId, trigger, looped);
            }
            index = target + step;
        }

        this.#busy = false;
        this.#target = this.#index;

        // Ran off the end without looping: stay on the current slide
        if (!wrap)
        {
            this.#end(trigger);
            return;
        }
        this.#fail(new Error('No slides could be loaded'), trigger);
    }

    async #reveal(img, index, navId, trigger, looped)
    {
        const slide = document.createElement('div');
        slide.className = 'slide';
        slide.setAttribute('part', 'slide');
        slide.append(img);

        // Snap any in-progress transition to its end before starting the next,
        // leaving only the slide on screen to fade out
        this.#anim?.finish();
        const outgoing = this.#stage.lastElementChild;
        while (outgoing?.previousElementSibling)
        {
            outgoing.previousElementSibling.remove();
        }
        this.#stage.append(slide);

        const previousIndex = this.#index;
        this.#index = index;
        if (looped && previousIndex >= 0)
        {
            this.#emit('loop', trigger, {index, previousIndex});
        }
        const detail = {index, previousIndex, slide: this.#slides[index]};
        this.#emit('slidechange', trigger, detail);

        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const duration = reduced ? 0 : this.transitionDuration;
        const motion = !reduced && normaliseMotion(this.#slides[index].motion ?? this.motion);
        if (motion)
        {
            // Spans the slide's whole time on screen: fading in, the interval, and fading out
            slide.animate(motion.keyframes, {
                id: 'motion',
                duration: this.interval + duration * 2,
                easing: motion.easing,
                fill: 'forwards',
            });
            this.#syncMotion();
        }
        if (duration > 0)
        {
            // Fade the old slide out too, so nothing it shows outside the new one (e.g. with
            // object-fit: contain) lingers and then vanishes
            outgoing?.animate([{opacity: 1}, {opacity: 0}], {duration, fill: 'forwards'});
            const anim = this.#anim = slide.animate([{opacity: 0}, {opacity: 1}], {duration});
            await anim.finished.catch(() => {});
            if (this.#anim === anim) this.#anim = null;
        }

        // Everything underneath is now hidden
        while (slide.previousElementSibling)
        {
            slide.previousElementSibling.remove();
        }

        // A later slide (or new config) took over before this one finished
        if (this.#stage.lastElementChild !== slide) return;
        this.#emit('slidechangeend', trigger, detail);

        if (navId !== this.#navId) return;

        this.#busy = false;
        if (this.#slides.length > 1)
        {
            this.#remaining = this.interval;
            this.#tick(trigger);
            this.#preloadFrom(index + 1);
        }
    }

    /** Auto-advance has run out of slides. */
    #end(trigger)
    {
        if (!this.#playing) return;
        this.#pause(trigger);
        this.#emit('ended', trigger);
    }

    #fail(error, trigger)
    {
        console.warn('[image-panel]', error);
        this.#emit('error', trigger, {error});
    }



    // Timing

    #play(trigger)
    {
        if (this.#playing) return;
        this.#playing = true;
        this.#emit('play', trigger);
        this.#syncMotion();
        if (!this.#busy && this.#index >= 0)
        {
            this.#remaining ??= this.interval;
        }
        this.#tick(trigger);

        // Like a media element, playing again from the end starts over
        if (this.#atEnd())
        {
            this.#goTo(0, trigger);
        }
    }

    #pause(trigger)
    {
        if (!this.#playing) return;
        this.#playing = false;
        this.#pauseTimer();
        this.#syncMotion();
        this.#emit('pause', trigger);
    }

    #tick(trigger)
    {
        if (!this.#playing || this.#holds.size || this.#timer || this.#remaining === null) return;

        this.#timerStart = performance.now();
        this.#timer = setTimeout(() => {
            this.#timer = 0;
            this.#remaining = null;
            this.#atEnd() ? this.#end('auto') : this.#step(1, 'auto');
        }, this.#remaining);
        this.#emit('countdown', trigger, {remaining: this.#remaining, interval: this.interval});
    }

    #pauseTimer()
    {
        if (!this.#timer) return;
        clearTimeout(this.#timer);
        this.#timer = 0;
        this.#remaining = Math.max(0, this.#remaining - (performance.now() - this.#timerStart));
    }

    #clearTimer()
    {
        clearTimeout(this.#timer);
        this.#timer = 0;
    }

    /** Slide motion only runs while auto-advance does, so pausing stops everything that moves. */
    #syncMotion()
    {
        const running = this.#playing && !this.#holds.size;
        for (const anim of this.#stage.getAnimations({subtree: true}))
        {
            // Playing a finished animation would rewind it
            if (anim.id !== 'motion' || anim.playState === 'finished') continue;
            if (!running) anim.pause();
            else if (anim.playState === 'paused') anim.play();
        }
    }

    /** Holds suspend auto-advance without changing `playing`: hover, focus, hidden tab, offscreen. */
    #setHold(reason, on)
    {
        if (on === this.#holds.has(reason)) return;

        const running = this.#playing && !this.#holds.size;
        if (on)
        {
            this.#holds.add(reason);
            this.#pauseTimer();
            this.#syncMotion();
            if (running) this.#emit('hold', reason);
        }
        else
        {
            this.#holds.delete(reason);
            this.#syncMotion();
            if (this.#playing && !this.#holds.size) this.#emit('resume', reason);
            this.#start();
            this.#tick(reason);
        }
    }



    // Events

    #onVisibilityChange = () => this.#setHold('hidden', document.hidden);

    #onKeydown = event =>
    {
        const action = KEYS[event.key];
        if (!action || !this.keyboard || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

        event.preventDefault();
        const {step, index} = action(this, getComputedStyle(this).direction === 'rtl');
        step ? this.#step(step, 'keyboard') : this.#goTo(index, 'keyboard');
    };

    #emit(type, trigger, detail)
    {
        this.dispatchEvent(new CustomEvent(type, {detail: {...detail, trigger}}));
    }

    /** Keyboard-enabled panels need to be focusable. Never set during construction, which throws. */
    #syncTabindex()
    {
        if (!this.isConnected) return;

        if (this.keyboard && !this.hasAttribute('tabindex'))
        {
            this.tabIndex = 0;
            this.#ownTabindex = true;
        }
        else if (!this.keyboard && this.#ownTabindex)
        {
            this.removeAttribute('tabindex');
            this.#ownTabindex = false;
        }
    }

    /** Re-run setters for properties assigned before the element was defined. */
    #upgradeProperty(prop)
    {
        if (Object.hasOwn(this, prop))
        {
            const value = this[prop];
            delete this[prop];
            this[prop] = value;
        }
    }
}



function normaliseSlide(slide, base)
{
    if (typeof slide === 'string')
    {
        slide = {src: slide};
    }
    if (!slide?.src) return null;

    return {
        ...slide,
        src: new URL(slide.src, base).href,
        srcset: slide.srcset ? resolveSrcset(slide.srcset, base) : '',
    };
}

/** Adds fields from the image's metadata where the slide doesn't set its own, then falls back from alt to title. */
function completeSlide(slide, metadata = {})
{
    for (const [field, value] of Object.entries(metadata))
    {
        slide[field] ??= value;
    }
    slide.alt ??= slide.title ?? '';
}

/**
 * A slide's `motion` as Web Animations keyframes. Accepts `'random'`, an array of transforms spread
 * evenly over the slide's lifespan, or an object with `from` and `to` (or `keyframes`) and an optional `easing`.
 */
function normaliseMotion(motion)
{
    if (motion === 'random') return randomMotion();
    if (!motion || typeof motion !== 'object') return null;

    const frames = Array.isArray(motion) ? motion : motion.keyframes ?? [motion.from, motion.to];
    if (!Array.isArray(frames) || frames.length < 2) return null;

    return {
        keyframes: frames.map(transform => ({transform: transform || 'none'})),
        easing: (!Array.isArray(motion) && motion.easing) || 'linear',
    };
}

/** A gentle zoom in or out between two random points, never showing the panel edges. */
function randomMotion()
{
    const near = 1 + Math.random() * 0.05;
    const far = 1.12 + Math.random() * 0.08;
    const frames = [frame(near), frame(far)];
    if (Math.random() < 0.5) frames.reverse();
    return {keyframes: frames, easing: 'linear'};

    function frame(scale)
    {
        // Translating before scaling, an offset of up to (scale - 1) / 2 keeps the image covering the panel
        const offset = () => ((Math.random() * 2 - 1) * (scale - 1) * 45).toFixed(2);
        return {transform: `translate(${offset()}%, ${offset()}%) scale(${scale.toFixed(3)})`};
    }
}

function resolveSrcset(srcset, base)
{
    return srcset
        .split(',')
        .map(candidate => {
            const [url, ...descriptors] = candidate.trim().split(/\s+/);
            return [new URL(url, base).href, ...descriptors].join(' ');
        })
        .join(', ');
}

function toNumber(value)
{
    if (value === null || value === undefined || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** In-place Fisher–Yates shuffle. */
function shuffle(array)
{
    for (let i = array.length - 1; i > 0; i--)
    {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}



if (!customElements.get('image-panel'))
{
    customElements.define('image-panel', ImagePanel);
}
