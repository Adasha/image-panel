

class ImagePanel extends HTMLElement
{
    #shadow;
    #imgLoader = new Image();
    #imgArr;
    #currImg = 0;
    #masterPath;
    #defaultSlideInterval = 6000;
    #defaultTransitionDuration = 0;
    #timer;
    #slideInterval;
    #transDur;
    #slideTemplate;


    static get observedAttributes() {
        return ['data', 'width', 'height', 'interval', 'fade-duration'];
    }

    constructor(...args)
    {
        super(...args);

        this.#shadow = this.attachShadow({mode: 'closed'});
        this.#imgLoader.addEventListener('load',  this.#slideLoaded.bind(this));
        this.#imgLoader.addEventListener('error', this.#slideLoadingError.bind(this));

        let style = document.createElement('style');
        style.textContent = `
            :host {
                display: block;
                position: relative;
                height: 100%;
            }
            :host > div {
                background-size: cover;
                background-position: center center;
                background-repeat: no-repeat;
                position: absolute;
                top: 0;
                right: 0;
                bottom: 0;
                left: 0;
            }
        `;
        this.#shadow.appendChild(style);

        this.#slideTemplate = document.createElement('div');
        this.#slideTemplate.className = 'image-slide';


    }


    startSlideshow(index)
    {
        // console.log('Slideshow started.');
        this.loadSlide(index || 0);
    }
    
    stopSlideshow()
    {
        // console.log('Slideshow stopped.');
    }

    loadSlide(index)
    {
        index = Utils.constrain(index, 0, this.#imgArr.length-1);
		var url = this.#masterPath + this.#imgArr[index].src;
		this.#currImg = index;
		this.#imgLoader.src = url;

    }
    
    prevSlide()
    {
		this.#currImg = (--this.#currImg+this.#imgArr.length)%this.#imgArr.length;
		this.loadSlide(this.#currImg);
    }

    nextSlide()
    {
		this.#currImg = (++this.#currImg)%this.#imgArr.length;
		this.loadSlide(this.#currImg);
    }

    pause()
    {
		if(this.#timer)
        {
			this.#timer.pause();
		}
    }

    resume()
    {
		if(this.#timer)
        {
			this.#timer.resume();
		}
    }

    connectedCallback()
    {
        // console.log('Element connected.');

        //this.#upgradeProperty('data');

    }

    disconnectedCallback()
    {
        // console.log('Element disconnected.');

    }

    attributeChangedCallback(name, oldValue, newValue)
    {
        // console.log('Attribute changed: '+name+'. New value: '+newValue);

        switch(name)
        {
            case 'data' :
                this.#loadData(newValue);
                break;
            case 'width' :
            case 'height' :
                break;
            case 'interval' :
                break;
            case 'fade-duration' :
                break;
            default:
        }
    }

    #upgradeProperty(prop)
    {
        if (this.hasOwnProperty(prop))
        {
            let value = this[prop];
            delete this[prop];
            this[prop] = value;
        }
    }

    get data()
    {
        return this.getAttribute('data');
    }

    set data(url)
    {
        this.setAttribute('data', url);
    }

    get width()
    {
        return this.getAttribute('width');
    }

    set width(val)
    {
        this.setAttribute('width', val);
    }

    get height()
    {
        return this.getAttribute('height');
    }

    set height(val)
    {
        this.setAttribute('height', val);
    }

    get interval()
    {
        return this.getAttribute('interval');
    }

    set interval(dur)
    {
        this.setAttribute('interval', dur);
    }


    get fadeDuration()
    {
        return this.getAttribute('fade-duration');
    }

    set fadeDuration(dur)
    {
        this.setAttribute('fade-duration', dur);
    }



    #loadData(url)
    {
        // console.log('Loading data from '+url);

        let req = new XMLHttpRequest();
        req.onreadystatechange = () => {
            if (req.readyState===XMLHttpRequest.DONE)
            {
                if (req.status===200)
                {
                    this.#dataLoaded(JSON.parse(req.responseText));                                
                }
                else
                {
                    this.#dataLoadingFailed(req);
                }
            }
        };
        req.open('GET', url, true);
        req.send();
    }

    #dataLoaded(data)
    {
        // console.log('Data loaded successfully.');

		this.#imgArr        = (Array.isArray(data)) ? data : data.slides;
		this.#masterPath    = data.masterPath         || '';
		this.#slideInterval = data.slideInterval      || this.#defaultSlideInterval;
		this.#transDur      = data.transitionDuration || this.#defaultTransitionDuration;
        
		if(data.shuffleSlides)
        {
			Utils.shuffleArray(this.#imgArr);
		}
		this.startSlideshow();
    }

    #dataLoadingFailed(err)
    {
        console.log('Data loading failed.');
        console.log(err);
    }

    #slideLoaded(evt)
    {
        // console.log('Slide loaded.');

		let oldSlide = this.#shadow.querySelector('*.image-slide'),
			newSlide = this.#slideTemplate.cloneNode(true),
			img = this.#imgArr[this.#currImg];
		
        newSlide.setAttribute('style', img.style || '');
		newSlide.style.backgroundImage = 'url(' + (this.#masterPath + img.src) + ')';

        if(oldSlide)
        {
            oldSlide.style.zIndex = '-1';
            newSlide.style.zIndex = '1';
        }
        
        this.#shadow.insertBefore(newSlide, oldSlide);
        // this.#shadow.appendChild(newSlide);

        
        let fadeIn = newSlide.animate(
            [
                {opacity: '0'},
                {opacity: '1'}
            ], this.fadeDuration || this.#transDur
        );

        fadeIn.addEventListener('finish', () => {
			if (oldSlide)
            {
				this.#shadow.removeChild(oldSlide);
			}
			this.#timer = new Timer(this.nextSlide.bind(this), this.interval || this.#slideInterval);
        });
		
    }

    #slideLoadingError(evt)
    {
        console.log('[ImagePanel.js] Image loading failed: \"'+evt.target.src+'\"');
        this.nextSlide();
    }
}

customElements.define('image-panel', ImagePanel);









class Timer
{
    #timerID;
    #start;
    #remaining;
    #callback;

    constructor(callback, delay)
    {
        this.#callback = callback;
        this.#remaining = delay;
        this.resume();
    }

    pause()
    {
        if(this.#timerID)
        {
            window.clearTimeout(this.#timerID);
            this.#remaining -= new Date() - this.#start;
            this.#timerID = null;
        }
    }

    resume()
    {
        if(this.#timerID)
        {
            window.clearTimeout(this.#timerID);
        }
        this.#start = new Date();
        this.#timerID = window.setTimeout(this.#callback, this.#remaining);
    }
}









class Utils
{
    static shuffleArray(array)
    {
        /* Randomize array element order in-place
         * using Durstenfeld shuffle algorithm.
         */

        let i, j, temp;

        for (i = array.length - 1; i > 0; i--) {
            j = Math.floor(Math.random() * (i + 1));
            temp = array[i];
            array[i] = array[j];
            array[j] = temp;
        }

        return array;
    }

    static constrain = (num, min, max) => {
        if (typeof num!=="number") {
            return NaN;
        }
        if (min!==undefined && min!==null && typeof min==="number") {
            num = Math.max(num, min);
        }
        if (max!==undefined && max!==null && typeof max==="number") {
            num = Math.min(num, max);
        }
        return num;
    };

}
