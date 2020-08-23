

class PhotoFrame extends HTMLElement
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
    #slideStyle = `
        background-repeat:   no-repeat;
        background-position: center center;
        background-size:     cover;
        position: absolute;
        left:   0;
        right:  0;
        bottom: 0;
        top:    0;
    `;


    static get observedAttributes() {
        return ['data', 'width', 'height', 'interval'];
    }

    constructor(...args)
    {
        super(...args);
        console.log('Element constructed.');

        this.#shadow = this.attachShadow({mode: 'closed'});
        this.#imgLoader.addEventListener('load',  this.#slideLoaded.bind(this));
        this.#imgLoader.addEventListener('error', this.#slideLoadingError.bind(this));

        this.style = `
            display: block;
            position: relative;
            width:  100%;
            height: 100%;
        `;
    }


    startSlideshow(index)
    {
        console.log('Slideshow started.');
        this.loadSlide(index || 0);
    }
    
    stopSlideshow()
    {
        console.log('Slideshow stopped.');
    }

    loadSlide(index)
    {
        console.log('Loading slide '+(index+1)+' of '+this.#imgArr.length);

		var url = this.#masterPath + this.#imgArr[index].src;
		this.#currImg = index;
		//console.log('Slideshow: Attempting to load \"' + url + '\"');
		this.#imgLoader.src = url;

    }
    
    prevSlide()
    {

    }

    nextSlide()
    {
		this.#currImg = (++this.#currImg)%this.#imgArr.length;
		this.loadSlide(this.#currImg);
    }

    pauseTimer()
    {
		if(this.#timer)
        {
			this.#timer.pause();
		}
    }

    resumeTimer()
    {
		if(this.#timer)
        {
			this.#timer.resume();
		}
    }

    connectedCallback()
    {
        console.log('Element connected.');

        //this.#upgradeProperty('data');

        this.#slideTemplate = document.createElement('div');
        //this.#slideTemplate.textContent = '&nbsp;';
        this.#slideTemplate.className = 'image-slide';
        this.#slideTemplate.style = String(this.#slideStyle);
    }

    disconnectedCallback()
    {
        console.log('Element disconnected.');

    }

    attributeChangedCallback(name, oldValue, newValue)
    {
        console.log('Attribute changed: '+name+'. New value: '+newValue);

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



    #loadData(url)
    {
        console.log('Loading data from '+url);

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
        console.log('Data loaded successfully.');

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
        console.log('Slide loaded.');

		let oldSlide = this.#shadow.querySelector('*.image-slide'),
			newSlide = this.#slideTemplate.cloneNode(true),
			img = this.#imgArr[this.#currImg];
		
        newSlide.setAttribute('style', img.style || '');
		newSlide.style.backgroundImage = 'url(' + (this.#masterPath + img.src) + ')';
		//newSlide.style.opacity         = '1';
        newSlide.style.position = 'absolute';
        newSlide.style.top = '0';
        newSlide.style.right = '0';
        newSlide.style.bottom = '0';
        newSlide.style.left = '0';
        newSlide.style.backgroundRepeat = 'no-repeat';
        newSlide.style.backgroundSize = 'cover';

        if(oldSlide)
        {
            oldSlide.style.opacity = '1';
            oldSlide.style.zIndex = '-1';
            newSlide.style.zIndex = '1';
        }
        
        this.#shadow.insertBefore(newSlide, oldSlide);
        // this.#shadow.appendChild(newSlide);

        
        let fadeIn = newSlide.animate(
            [
                {opacity: '0'},
                {opacity: '1'}
            ], this.interval
        );

        fadeIn.addEventListener('finish', () => {
            console.log(newSlide.style.opacity);
			if (oldSlide)
            {
				this.#shadow.removeChild(oldSlide);
			}
			this.#timer = new Timer(this.nextSlide.bind(this), this.#slideInterval);
        });
		
    }

    #slideLoadingError(evt)
    {
        console.log('[Slideshow] Image loading failed: \"'+evt.target.src+'\"');
        this.nextSlide();
    }
}

customElements.define('photo-frame', PhotoFrame);









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
}
