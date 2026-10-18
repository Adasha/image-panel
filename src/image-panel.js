/*!
 * <image-panel> web component
 * https://github.com/Adasha/image-panel
 * @license MPL-2.0
 */

const DEFAULT_INTERVAL = 6000;
const DEFAULT_TRANSITION = 1000;

const FLIPS = {
    horizontal: 'scaleX(-1)',
    vertical: 'scaleY(-1)',
    both: 'scale(-1, -1)',
};

const KEYS = {
    ArrowLeft: (panel, rtl) => rtl ? panel.next() : panel.prev(),
    ArrowRight: (panel, rtl) => rtl ? panel.prev() : panel.next(),
    Home: panel => panel.goTo(0),
    End: panel => panel.goTo(panel.length - 1),
};

const UPGRADABLE = [
    'src', 'config', 'interval', 'transitionDuration', 'autoplay', 'shuffle', 'loop',
    'startIndex', 'fit', 'position', 'sizes', 'keyboard', 'pauseOnHover',
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
    img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: var(--image-panel-fit, cover);
        object-position: var(--image-panel-position, center);
    }
    .status {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
</style>
<div class="slides"></div>
<div class="status" aria-live="polite" aria-atomic="true"></div>
`;


/**
 * Minimal, configurable image viewer.
 *
 * @fires ready       - Slides are loaded and ready to show. detail: { length }
 * @fires slidechange - A new slide is shown. detail: { index, previousIndex, slide }
 * @fires slideerror  - A slide image failed to load and was skipped. detail: { index, slide }
 * @fires error       - The config failed to load, or no slide could be shown. detail: { error }
 * @fires play
 * @fires pause
 *
 * @csspart slide - Wrapper around each slide; this is what fades.
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
    #status;

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
        this.#status = this.#root.querySelector('.status');

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
                    this.#tick();
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
        if (this.#playing) return;
        this.#playing = true;
        if (!this.#busy && this.#index >= 0)
        {
            this.#remaining ??= this.interval;
        }
        this.#tick();
        this.#updateLive();
        this.#emit('play');

        // Like a media element, playing again from the end starts over
        if (this.#atEnd())
        {
            this.goTo(0);
        }
    }

    /** Stop auto-advancing. The current slide stays visible. */
    pause()
    {
        if (!this.#playing) return;
        this.#playing = false;
        this.#pauseTimer();
        this.#updateLive();
        this.#emit('pause');
    }

    /** Show the next slide, wrapping round at the end if `loop` is on. */
    next()
    {
        this.#step(1);
    }

    /** Show the previous slide, wrapping round at the start if `loop` is on. */
    prev()
    {
        this.#step(-1);
    }

    /** Show the slide at the given index. Out-of-range indexes wrap if `loop` is on, and are ignored otherwise. */
    goTo(index)
    {
        index = Math.trunc(Number(index));
        if (!Number.isFinite(index) || (index === this.#index && !this.#busy)) return;
        if (!this.loop && (index < 0 || index >= this.#slides.length)) return;
        this.#show(index, 1);
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
                this.#fail(error);
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
            alt: img.alt,
            title: img.title,
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

        if (this.shuffle)
        {
            shuffle(this.#slides);
        }
        if (!this.#slides.length)
        {
            this.#stage.replaceChildren();
            this.#status.textContent = '';
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

        this.#emit('ready', {length: this.#slides.length});
        this.#start();
    }

    #start()
    {
        if (this.#index >= 0 || this.#busy || !this.#slides.length || this.#holds.has('offscreen')) return;

        if (this.autoplay)
        {
            this.play();
        }
        this.#show(this.startIndex, 1);
    }

    #createImage(index, priority)
    {
        const slide = this.#slides[index];
        const img = document.createElement('img');

        img.setAttribute('part', 'image');
        img.decoding = 'async';
        img.fetchPriority = priority;
        img.alt = slide.alt;

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

        const ready = img.decode().then(
            () => img,
            // decode() can reject for reasons other than a broken image
            () => img.complete && img.naturalWidth ? img : null,
        );
        return {index, ready};
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
        this.#preload = this.#createImage(next, 'low');
    }

    #nextLoadable(index, step, wrap = this.loop)
    {
        const length = this.#slides.length;
        for (let tries = 0; tries < length; tries++, index += step)
        {
            if (!wrap && (index < 0 || index >= length)) break;
            const wrapped = ((index % length) + length) % length;
            if (!this.#failed.has(wrapped)) return wrapped;
        }
        return -1;
    }

    /** True when showing the last loadable slide and not looping. */
    #atEnd()
    {
        return this.#index >= 0 && !this.#busy && !this.loop && this.#nextLoadable(this.#index + 1, 1) === -1;
    }



    // Display

    #step(step)
    {
        // Without looping, stepping off either end does nothing
        if (!this.loop && this.#nextLoadable(this.#target + step, step) === -1) return;
        this.#show(this.#target + step, step);
    }

    async #show(index, step)
    {
        if (!this.#slides.length) return;

        // The first slide may wrap round to find one that loads, even without looping
        const wrap = this.loop || this.#index < 0;
        const navId = ++this.#navId;
        this.#busy = true;
        this.#clearTimer();
        this.#remaining = null;

        let target;
        while ((target = this.#nextLoadable(index, step, wrap)) !== -1)
        {
            this.#target = target;
            const pending = this.#preload?.index === target
                ? this.#preload
                : this.#createImage(target, this.#index < 0 ? 'high' : 'auto');
            this.#preload = null;

            const img = await pending.ready;
            if (navId !== this.#navId) return;

            if (img)
            {
                return this.#reveal(img, target, navId);
            }

            this.#failed.add(target);
            this.#emit('slideerror', {index: target, slide: this.#slides[target]});
            console.warn(`[image-panel] Failed to load "${this.#slides[target].src}"`);
            index = target + step;
        }

        this.#busy = false;
        this.#target = this.#index;

        // Ran off the end without looping: stay on the current slide
        if (!wrap)
        {
            this.pause();
            return;
        }
        this.#fail(new Error('No slides could be loaded'));
    }

    async #reveal(img, index, navId)
    {
        const slide = document.createElement('div');
        slide.className = 'slide';
        slide.setAttribute('part', 'slide');
        slide.append(img);

        // Snap any in-progress transition to its end before starting the next
        this.#anim?.finish();
        this.#stage.append(slide);

        const previousIndex = this.#index;
        this.#index = index;
        if (previousIndex >= 0)
        {
            this.#announce();
        }
        this.#emit('slidechange', {index, previousIndex, slide: this.#slides[index]});

        const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : this.transitionDuration;
        if (duration > 0)
        {
            const anim = this.#anim = slide.animate([{opacity: 0}, {opacity: 1}], {duration});
            await anim.finished.catch(() => {});
            if (this.#anim === anim) this.#anim = null;
        }

        // Everything underneath is now hidden
        while (slide.previousElementSibling)
        {
            slide.previousElementSibling.remove();
        }

        if (navId !== this.#navId) return;

        this.#busy = false;
        if (this.#slides.length > 1)
        {
            this.#remaining = this.interval;
            this.#tick();
            this.#preloadFrom(index + 1);
        }
    }

    #announce()
    {
        const {alt} = this.#slides[this.#index];
        this.#status.textContent = `Slide ${this.#index + 1} of ${this.#slides.length}${alt ? `: ${alt}` : ''}`;
    }

    #updateLive()
    {
        // Don't announce slides that change on their own (WAI-ARIA carousel pattern)
        this.#status.ariaLive = this.#playing && !this.#holds.size ? 'off' : 'polite';
    }

    #fail(error)
    {
        console.warn('[image-panel]', error);
        this.#emit('error', {error});
    }



    // Timing

    #tick()
    {
        if (!this.#playing || this.#holds.size || this.#timer || this.#remaining === null) return;

        this.#timerStart = performance.now();
        this.#timer = setTimeout(() => {
            this.#timer = 0;
            this.#remaining = null;
            this.#atEnd() ? this.pause() : this.next();
        }, this.#remaining);
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

    /** Holds suspend auto-advance without changing `playing`: hover, focus, hidden tab, offscreen. */
    #setHold(reason, on)
    {
        if (on === this.#holds.has(reason)) return;

        if (on)
        {
            this.#holds.add(reason);
            this.#pauseTimer();
        }
        else
        {
            this.#holds.delete(reason);
            this.#start();
            this.#tick();
        }
        this.#updateLive();
    }



    // Events

    #onVisibilityChange = () => this.#setHold('hidden', document.hidden);

    #onKeydown = event =>
    {
        const action = KEYS[event.key];
        if (!action || !this.keyboard || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

        event.preventDefault();
        action(this, getComputedStyle(this).direction === 'rtl');
    };

    #emit(type, detail)
    {
        this.dispatchEvent(new CustomEvent(type, {detail}));
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
        alt: slide.alt ?? slide.title ?? '',
    };
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
