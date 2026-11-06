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

const DIRECTIONS = {
    left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
    'up-left': [-1, -1], 'up-right': [1, -1], 'down-left': [-1, 1], 'down-right': [1, 1],
};
const CARDINALS = ['left', 'right', 'up', 'down'];
const DIAGONALS = ['up-left', 'up-right', 'down-left', 'down-right'];
const DIRECTION_SETS = {
    random: [...CARDINALS, ...DIAGONALS],
    cardinal: CARDINALS,
    diagonal: DIAGONALS,
};
const DEFAULT_EASING = 'ease-in-out';
const WIPE = '--image-panel-wipe';

// Lets a wipe's mask edge be animated. Registration is document-wide, so another copy may have done it already.
try
{
    CSS.registerProperty({name: WIPE, syntax: '<length-percentage>', inherits: false, initialValue: '0%'});
}
catch {}

const KEYS = {
    ArrowLeft: (panel, rtl) => ({step: rtl ? 1 : -1}),
    ArrowRight: (panel, rtl) => ({step: rtl ? -1 : 1}),
    Home: () => ({index: 0}),
    End: panel => ({index: panel.length - 1}),
};

const UPGRADABLE = [
    'metadata', 'src', 'config', 'interval', 'transitionDuration', 'autoplay', 'shuffle', 'loop',
    'startIndex', 'fit', 'position', 'sizes', 'fillPanel', 'motion', 'transition', 'transitionEasing', 'keyboard', 'pauseOnHover',
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
    .slides, .slide, .motion, img {
        position: absolute;
        inset: 0;
    }
    .slides {
        isolation: isolate;
    }
    .slide {
        /* Keep rotated or offset images inside the slide, so moving slides have straight edges. Motion runs
           inside it, on .motion, so the edges stay square to the panel while the image moves */
        overflow: clip;
    }
    .slide.blend {
        /* Opacities add rather than layer, so a cross-fade stays solid where slides overlap */
        mix-blend-mode: plus-lighter;
    }
    .dip {
        position: absolute;
        inset: 0;
        opacity: 0;
        pointer-events: none;
        background-color: var(--image-panel-dip-color, black);
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
<div class="dip" part="dip"></div>
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
 * @csspart slide - Wrapper around each slide; this is what transitions and moves.
 * @csspart image - The <img> inside each slide.
 * @csspart dip   - The colour layer a `dip` transition fades through.
 *
 * @cssprop --image-panel-fit       - Default object-fit (cover).
 * @cssprop --image-panel-position  - Default object-position (center).
 * @cssprop --image-panel-dip-color - Colour a `dip` transition fades through, unless it names its own (black).
 */
export class ImagePanel extends HTMLElement
{
    static observedAttributes = ['src', 'interval', 'keyboard'];

    #internals = this.attachInternals();
    #root = this.attachShadow({mode: 'open'});
    #stage;
    #dip;

    #source = null;         // 'src' | 'config' | 'children'
    #config = {};
    #slides = [];
    #failed = new Set();
    #index = -1;
    #target = -1;           // slide being loaded, or the current one
    #navId = 0;
    #busy = false;
    #anims = [];            // the running transition's animations
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
    // Covering depends on the panel's shape, and can't be worked out at all while it has no size
    #resize = new ResizeObserver(() => this.#recover());


    constructor()
    {
        super();

        this.#root.append(template.content.cloneNode(true));
        this.#stage = this.#root.querySelector('.slides');
        this.#dip = this.#root.querySelector('.dip');

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
        this.#resize.observe(this);
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
        this.#resize.disconnect();
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

    /** Transition duration in milliseconds. 0 for a hard cut. Ignored when the user prefers reduced motion. */
    get transitionDuration() { return toNumber(this.getAttribute('transition-duration')) ?? toNumber(this.#config.transitionDuration) ?? DEFAULT_TRANSITION; }
    set transitionDuration(ms) { this.setAttribute('transition-duration', ms); }

    get autoplay() { return this.#flag('autoplay', 'autoplay'); }
    set autoplay(value) { this.setAttribute('autoplay', value ? '' : 'false'); }

    get shuffle() { return this.#flag('shuffle', 'shuffle'); }
    set shuffle(value) { this.setAttribute('shuffle', value ? '' : 'false'); }

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

    /**
     * Keep every slide covering the whole panel: fits that leave gaps become `cover`, and image transforms,
     * motion and transition easings are adjusted so they never show the background. Takes effect from the next slide.
     */
    get fillPanel() { return this.#flag('fill-panel', 'fillPanel'); }
    set fillPanel(value) { this.setAttribute('fill-panel', value ? '' : 'false'); }

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
     * Default transition for slides without their own: `'fade'`, `'none'`, `'dip [colour]'`, or
     * `'wipe'`, `'slide'` or `'push'` with an optional direction (cardinal only for push) (and for wipes, a feather width, e.g. `'wipe up 10%'`).
     * Takes effect from the next slide.
     */
    get transition() { return this.getAttribute('transition') ?? this.#config.transition ?? 'fade'; }
    set transition(value) { this.setAttribute('transition', value); }

    /**
     * Easing for transitions that move (wipe, slide and push): any CSS easing function. Fade and dip keep their own.
     * Takes effect from the next slide.
     */
    get transitionEasing() { return this.getAttribute('transition-easing') ?? this.#config.transitionEasing ?? DEFAULT_EASING; }
    set transitionEasing(value) { this.setAttribute('transition-easing', value); }

    /**
     * Fill in each slide's missing `title`, `description`, `alt`, `creator` and `copyright` from its image file's
     * metadata, when the slide first loads. Takes effect from the next config.
     */
    get metadata() { return this.#flag('metadata', 'metadata'); }
    set metadata(value) { this.setAttribute('metadata', value ? '' : 'false'); }

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
        this.#show(this.startIndex, 1, 'start', true);
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
        this.#show(this.#target + step, step, trigger, step > 0);
    }

    #goTo(index, trigger)
    {
        index = Math.trunc(Number(index));
        if (!Number.isFinite(index) || (index === this.#index && !this.#busy)) return;
        if (!this.loop && (index < 0 || index >= this.#slides.length)) return;
        this.#show(index, 1, trigger, index >= this.#target);
    }

    /** `forward` says which way navigation went, for transitions that follow it. */
    async #show(index, step, trigger, forward)
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
                return this.#reveal(img, target, navId, trigger, looped, forward);
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

    async #reveal(img, index, navId, trigger, looped, forward)
    {
        const slide = document.createElement('div');
        slide.className = 'slide';
        slide.setAttribute('part', 'slide');
        const frame = document.createElement('div');
        frame.className = 'motion';
        frame.setAttribute('part', 'motion');
        frame.append(img);
        slide.append(frame);

        // Snap any in-progress transition to its end before starting the next,
        // leaving only the slide on screen to fade out
        for (const anim of this.#anims) anim.finish();
        this.#anims = [];
        const outgoing = this.#stage.lastElementChild;
        while (outgoing?.previousElementSibling)
        {
            outgoing.previousElementSibling.remove();
        }
        this.#stage.append(slide);
        const fill = this.fillPanel;
        if (fill)
        {
            coverPanel(img);
        }

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
            const timing = {duration: this.interval + duration * 2, fill: 'forwards'};
            // The zoom goes on the image, inside the slide's motion, so it zooms the composition without
            // changing the pan or angle. An overshoot would carry the motion past the zoom worked out for it
            // It's there even when no zoom is needed yet, so a resize only has to change its keyframes
            if (fill) motion.easing = clampEasing(motion.easing);
            frame.animate(motion.keyframes, {...timing, id: 'motion', easing: motion.easing});
            if (fill) img.animate(motionCoverZoom(frame, img, motion.keyframes), {...timing, id: 'motion-zoom', easing: motion.easing});
            this.#syncMotion();
        }
        const transition = duration > 0 && parseTransition(
            ownOr(this.#slides[index].transition, this.transition),
            forward !== (getComputedStyle(this).direction === 'rtl'),
        );
        if (transition)
        {
            transition.easing = validEasing(ownOr(this.#slides[index].transitionEasing, this.transitionEasing));
            // An overshoot would carry slide and push past their ends, opening a gap at the edge
            if (fill) transition.easing = clampEasing(transition.easing);
        }
        slide.classList.toggle('blend', transition?.type === 'fade');
        if (transition)
        {
            const anims = this.#anims = this.#animateTransition(transition, slide, outgoing, duration);
            // The incoming slide's animation always spans the whole transition
            await anims[0].finished.catch(() => {});
            if (this.#anims === anims) this.#anims = [];
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

    /** Starts a transition from `outgoing` (if any) to `incoming`. The incoming slide's animation comes first. */
    #animateTransition({type, direction, color, feather, easing}, incoming, outgoing, duration)
    {
        // The outgoing slide holds its end state until it's removed, so nothing it shows outside
        // the incoming one (e.g. with object-fit: contain) lingers and then vanishes
        const out = keyframes => outgoing?.animate(keyframes, {duration, easing, fill: 'forwards'});
        const [dx, dy] = DIRECTIONS[direction] ?? [0, 0];
        const anims = [];

        switch (type)
        {
            case 'dip':
            {
                // Fade to the colour, swap slides while it covers everything, then fade back
                const swap = {duration, easing: 'steps(2, jump-none)'};
                anims.push(incoming.animate([{opacity: 0}, {opacity: 1}], swap));
                outgoing && anims.push(outgoing.animate([{opacity: 1}, {opacity: 0}], {...swap, fill: 'forwards'}));
                this.#dip.style.backgroundColor = color ?? '';
                anims.push(this.#dip.animate([
                    {opacity: 0, easing: 'ease-in'},
                    {opacity: 1, easing: 'ease-out'},
                    {opacity: 0},
                ], {duration}));
                break;
            }
            case 'wipe':
            {
                // The mask's edge runs from fully transparent to fully opaque, `feather` wide
                incoming.style.maskImage = wipeMask(dx, dy, feather);
                const anim = incoming.animate({[WIPE]: ['0%', `calc(100% + ${feather})`]}, {duration, easing});
                const unmask = () => incoming.style.maskImage = '';
                anim.finished.then(unmask, unmask);
                anims.push(anim);
                break;
            }

            case 'slide':
            case 'push':
                // `translate` composes with any motion on `transform`, and its percentages are of the panel
                anims.push(incoming.animate({translate: [`${-dx * 100}% ${-dy * 100}%`, '0 0']}, {duration, easing}));
                if (type === 'push')
                {
                    anims.push(out({translate: ['0 0', `${dx * 100}% ${dy * 100}%`]}));
                }
                break;

            default:
                anims.push(incoming.animate([{opacity: 0}, {opacity: 1}], {duration}));
                anims.push(outgoing?.animate([{opacity: 1}, {opacity: 0}], {duration, fill: 'forwards'}));
        }
        return anims.filter(Boolean);
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

    /**
     * An on/off setting that config can also turn on. The attribute wins over config either way, so
     * `name="false"` (which the property sets when turned off) keeps it off whatever config says.
     */
    #flag(name, key)
    {
        const attr = this.getAttribute(name);
        return attr === null ? !!this.#config[key] : attr !== 'false';
    }

    /** Works out the fill-panel zoom again for the slides on screen, for the panel's current size. */
    #recover()
    {
        if (!this.fillPanel) return;
        for (const slide of this.#stage.children)
        {
            const frame = slide.querySelector('.motion');
            const img = frame.querySelector('img');
            coverPanel(img);
            const motion = frame.getAnimations().find(anim => anim.id === 'motion');
            const zoom = img.getAnimations().find(anim => anim.id === 'motion-zoom');
            if (motion && zoom)
            {
                const keyframes = motion.effect.getKeyframes().map(({transform, offset}) => ({transform, offset}));
                zoom.effect.setKeyframes(motionCoverZoom(frame, img, keyframes));
            }
        }
    }

    /** Slide motion only runs while auto-advance does, so pausing stops everything that moves. */
    #syncMotion()
    {
        const running = this.#playing && !this.#holds.size;
        for (const anim of this.#stage.getAnimations({subtree: true}))
        {
            // Playing a finished animation would rewind it
            if (!anim.id.startsWith('motion') || anim.playState === 'finished') continue;
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

const covers = new WeakMap(); // image -> its transform as set, and as last covered

/**
 * Makes an attached image cover its box: no letterboxing, and no transform that leaves gaps.
 * Can be run again, as the box changes, without stacking zoom on zoom.
 */
function coverPanel(img)
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
function motionCoverZoom(frame, img, keyframes)
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
function clampEasing(easing)
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

/** A slide's own setting, unless it's left empty. */
function ownOr(own, fallback)
{
    return own === undefined || own === null || own === '' ? fallback : own;
}

/** The easing if it's one CSS (and so Web Animations) understands, or the default. */
function validEasing(easing)
{
    if (CSS.supports('transition-timing-function', easing)) return easing;
    console.warn(`[image-panel] Invalid transition easing "${easing}"`);
    return DEFAULT_EASING;
}

/**
 * A transition string as `{type, direction, color}`, or null for a hard cut. `forward` is whether
 * navigation went towards the next slide in reading order, for directional transitions without a direction.
 */
function parseTransition(value, forward)
{
    if (value === false) return null;
    const [name = '', ...rest] = String(value ?? '').trim().split(/\s+/);
    const type = name.toLowerCase();
    const option = rest.join(' ');

    switch (type)
    {
        case 'none':
        case 'cut':
            return null;

        case 'dip':
            return {type, color: option || undefined};

        case 'wipe':
        case 'slide':
        case 'push':
        {
            // A direction or direction set, and for wipes a feather width, in either order.
            // Pushing diagonally leaves gaps at the corners, so push only goes in cardinal directions.
            const allowed = direction => type !== 'push' || CARDINALS.includes(direction);
            let direction = forward ? 'left' : 'right';
            let feather = '0px';
            for (const token of rest)
            {
                const key = token.toLowerCase();
                const set = DIRECTION_SETS[key]?.filter(allowed);
                if (set?.length) direction = set[Math.floor(Math.random() * set.length)];
                else if (DIRECTIONS[key] && allowed(key)) direction = key;
                else if (/^\d*\.?\d+$/.test(token)) feather = `${token}px`;
                else if (CSS.supports('width', token) && /\d/.test(token)) feather = token;
            }
            return type === 'wipe' ? {type, direction, feather} : {type, direction};
        }
        default:
            // 'fade', 'dissolve' or anything unrecognised
            return {type: 'fade'};
    }
}

/**
 * A mask revealing the slide behind an edge travelling in direction (dx, dy), positioned by the `--image-panel-wipe`
 * property: 0% hides everything, and 100% plus the feather shows everything. Diagonal edges run corner to corner.
 */
function wipeMask(dx, dy, feather)
{
    const side = [dy < 0 ? 'top' : dy > 0 ? 'bottom' : '', dx < 0 ? 'left' : dx > 0 ? 'right' : ''].filter(Boolean).join(' ');
    return `linear-gradient(to ${side}, black calc(var(${WIPE}) - ${feather}), transparent var(${WIPE}))`;
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
