/**
 * Reads descriptive metadata from the header of a JPEG or PNG: XMP, plus EXIF and IPTC where present.
 * Only the bytes before the image data are downloaded.
 */

const LIMIT = 256 * 1024;

const XMP = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    dc: 'http://purl.org/dc/elements/1.1/',
    photoshop: 'http://ns.adobe.com/photoshop/1.0/',
    Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
};

// Sources for each slide field, best first. IPTC datasets are record 2; EXIF tags are from IFD0.
const FIELDS = {
    title: ['dc:title', 'iptc:5', 'photoshop:Headline', 'iptc:105'],
    description: ['dc:description', 'iptc:120', 'exif:0x010E'],
    alt: ['Iptc4xmpCore:AltTextAccessibility'],
    creator: ['dc:creator', 'iptc:80', 'exif:0x013B'],
    copyright: ['dc:rights', 'iptc:116', 'exif:0x8298'],
};

// Camera firmware fills in descriptions like "OLYMPUS DIGITAL CAMERA" or "SONY DSC"
const PLACEHOLDER = /^(?:[\w ]*DIGITAL CAMERA|SONY DSC|default)?$/i;

const utf8 = new TextDecoder('utf-8', {fatal: true});
const latin1 = new TextDecoder('windows-1252');


/**
 * The `title`, `description`, `alt`, `creator` and `copyright` found in an image file, leaving out any it lacks.
 * Language alternatives are matched against `lang`. Rejects if the file can't be fetched.
 */
export async function readMetadata(url, {lang = '', priority = 'auto'} = {})
{
    const bytes = await readHeader(url, priority);
    const {exif, iptc} = scan(bytes);
    const sources = {
        xmp: attempt(() => parseXmp(bytes)),
        exif: Object.assign({}, ...exif.map(block => attempt(() => parseExif(block)))),
        iptc: Object.assign({}, ...iptc.map(block => attempt(() => parseIptc(block)))),
    };

    const metadata = {};
    for (const [field, keys] of Object.entries(FIELDS))
    {
        for (const key of keys)
        {
            const value = lookup(sources, key, lang)?.trim();
            if (value && !PLACEHOLDER.test(value))
            {
                metadata[field] = value;
                break;
            }
        }
    }
    return metadata;
}

function lookup({xmp, exif, iptc}, key, lang)
{
    const [prefix, name] = key.split(':');
    if (prefix === 'exif') return exif[Number(name)];
    if (prefix === 'iptc') return iptc[Number(name)];
    return xmp && xmpValue(xmp, XMP[prefix], name, lang);
}

function attempt(parse)
{
    try
    {
        return parse();
    }
    catch
    {
        // Malformed blocks are ignored
        return null;
    }
}



// Reading

/** Streams the file until its metadata has all arrived, then cancels the rest of the download. */
async function readHeader(url, priority)
{
    const response = await fetch(url, {priority});
    if (!response.ok)
    {
        throw new Error(`HTTP ${response.status} loading ${response.url}`);
    }

    const reader = response.body.getReader();
    const buffer = new Uint8Array(LIMIT);
    let length = 0;
    try
    {
        while (length < LIMIT && !scan(buffer.subarray(0, length)).complete)
        {
            const {done, value} = await reader.read();
            if (done) break;
            const size = Math.min(value.length, LIMIT - length);
            buffer.set(value.subarray(0, size), length);
            length += size;
        }
    }
    finally
    {
        reader.cancel().catch(() => {});
    }
    return buffer.subarray(0, length);
}

/**
 * Walks the JPEG segments or PNG chunks before the image data, collecting the EXIF and IPTC blocks.
 * `complete` is false while more of the header is still to come. Other formats are complete straight away.
 */
function scan(bytes)
{
    const found = {complete: false, exif: [], iptc: []};
    if (bytes.length < 8) return found;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    found.complete = true;

    if (view.getUint16(0) === 0xFFD8)
    {
        for (let i = 2; i + 4 <= bytes.length;)
        {
            const marker = view.getUint16(i);
            // Start of scan, end of image, or not a marker at all
            if (marker === 0xFFDA || marker === 0xFFD9 || marker >>> 8 !== 0xFF) return found;

            const start = i + 4;
            const end = i + 2 + view.getUint16(i + 2);
            if (end > bytes.length) break;
            if (marker === 0xFFE1 && ascii(bytes, start, 6) === 'Exif\0\0') found.exif.push(bytes.subarray(start + 6, end));
            if (marker === 0xFFED && ascii(bytes, start, 14) === 'Photoshop 3.0\0') found.iptc.push(bytes.subarray(start + 14, end));
            i = end;
        }
        found.complete = false;
    }
    else if (view.getUint32(0) === 0x89504E47)
    {
        for (let i = 8; i + 8 <= bytes.length;)
        {
            const type = ascii(bytes, i + 4, 4);
            if (type === 'IDAT' || type === 'IEND') return found;

            const end = i + 12 + view.getUint32(i);
            if (end > bytes.length) break;
            if (type === 'eXIf') found.exif.push(bytes.subarray(i + 8, end - 4));
            i = end;
        }
        found.complete = false;
    }
    return found;
}



// Parsing

/** The XMP packet as an XML document. Found by searching the header, so it works whatever the container. */
function parseXmp(bytes)
{
    // Single-byte decoding keeps string offsets equal to byte offsets
    const match = /<x:x[ma]pmeta[\s\S]*?<\/x:x[ma]pmeta>/.exec(latin1.decode(bytes));
    if (!match) return null;

    const xml = decode(bytes.subarray(match.index, match.index + match[0].length));
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return doc.querySelector('parsererror') ? null : doc;
}

/** A simple property, a list (joined with commas), or the best language alternative. */
function xmpValue(doc, ns, name, lang)
{
    for (const description of doc.getElementsByTagNameNS(XMP.rdf, 'Description'))
    {
        if (description.hasAttributeNS(ns, name)) return description.getAttributeNS(ns, name);
    }

    const property = doc.getElementsByTagNameNS(ns, name)[0];
    if (!property) return undefined;

    const items = [...property.getElementsByTagNameNS(XMP.rdf, 'li')];
    if (!items.length) return property.textContent;
    if (!property.getElementsByTagNameNS(XMP.rdf, 'Alt').length) return items.map(li => li.textContent.trim()).join(', ');

    const wanted = lang.toLowerCase();
    const langOf = li => (li.getAttribute('xml:lang') ?? '').toLowerCase();
    const item = items.find(li => wanted && langOf(li) === wanted)
        ?? items.find(li => wanted && langOf(li).split('-')[0] === wanted.split('-')[0])
        ?? items.find(li => langOf(li) === 'x-default')
        ?? items[0];
    return item.textContent;
}

/** ASCII tags from IFD0 of a TIFF-structured EXIF block, keyed by tag number. */
function parseExif(tiff)
{
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const little = view.getUint16(0) === 0x4949;
    const ifd = view.getUint32(4, little);
    const values = {};

    for (let i = 0, count = view.getUint16(ifd, little); i < count; i++)
    {
        const entry = ifd + 2 + i * 12;
        if (view.getUint16(entry + 2, little) !== 2) continue;

        const length = view.getUint32(entry + 4, little);
        const offset = length > 4 ? view.getUint32(entry + 8, little) : entry + 8;
        // Copyright holds "photographer\0editor"
        values[view.getUint16(entry, little)] = decode(tiff.subarray(offset, offset + length)).split('\0').filter(Boolean).join(', ');
    }
    return values;
}

/** Record 2 datasets from the IPTC-NAA resource of a Photoshop block, keyed by dataset number. */
function parseIptc(block)
{
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const values = {};

    for (let i = 0; i + 12 <= block.length && ascii(block, i, 4) === '8BIM';)
    {
        // Resource ID, then a Pascal string name padded to an even length, then the data size
        const id = view.getUint16(i + 4);
        const nameLength = block[i + 6] + 1;
        const sizeAt = i + 6 + nameLength + (nameLength % 2);
        const size = view.getUint32(sizeAt);
        const start = sizeAt + 4;

        if (id === 0x0404)
        {
            for (let j = start; j + 5 <= start + size && block[j] === 0x1C;)
            {
                const length = view.getUint16(j + 3);
                // Extended lengths are only used for binary data
                if (length & 0x8000) break;
                if (block[j + 1] === 2)
                {
                    const value = decode(block.subarray(j + 5, j + 5 + length));
                    const dataset = block[j + 2];
                    // Repeated datasets, such as several by-lines, are joined
                    values[dataset] = values[dataset] ? `${values[dataset]}, ${value}` : value;
                }
                j += 5 + length;
            }
        }
        i = start + size + (size % 2);
    }
    return values;
}

/** Text that should be UTF-8, but older tools often wrote Latin-1. */
function decode(bytes)
{
    try
    {
        return utf8.decode(bytes);
    }
    catch
    {
        return latin1.decode(bytes);
    }
}

function ascii(bytes, start, length)
{
    return String.fromCharCode(...bytes.subarray(start, start + length));
}
