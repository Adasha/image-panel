import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import Ajv2020 from 'ajv/dist/2020.js';

// Checks run in Node, not the page, so once is enough
test.skip(({browserName}) => browserName !== 'chromium', 'Browser-independent');

const require = createRequire(import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

// Resolved through the package's own exports map, as another project would
const schema = JSON.parse(readFileSync(require.resolve('image-panel/schema.json'), 'utf8'));
const ajv = new Ajv2020({allErrors: true, strict: false});
const validate = ajv.compile(schema);
const valid = config => (validate(config), validate.errors ?? []);

test.describe('schema', () => {
    test('accepts the demo and test configs', () => {
        expect(valid(read('../demo/slideshow.json'))).toEqual([]);
        expect(valid(read('./config.json'))).toEqual([]);
    });

    test('accepts a bare slide array, and slides with fields of their own', () => {
        expect(valid(['a.jpg', {src: 'b.jpg', caption: 'kept and passed back in events'}])).toEqual([]);
    });

    test('accepts every motion form', () => {
        for (const motion of [
            'random', 'none', false,
            ['scale(1.1)', 'scale(1)'],
            {from: 'scale(1)', to: 'scale(1.2)', easing: 'ease-out', origin: 'center'},
            {keyframes: ['scale(1)', null, 'scale(1.1)']},
        ])
        {
            expect(valid({motion, slides: [{src: 'a.jpg', motion}]}), JSON.stringify(motion)).toEqual([]);
        }
    });

    test('accepts transitions with options, and false', () => {
        for (const transition of ['fade', 'dip #1a1a1a', 'wipe diagonal 40px', 'push cardinal', 'cut', false])
        {
            expect(valid({transition, slides: [{src: 'a.jpg', transition}]}), String(transition)).toEqual([]);
        }
    });

    test('rejects mistakes', () => {
        for (const config of [
            {fit: 'stretch'},
            {intervall: 5000},
            {focalRange: '40'},
            {transition: 'spin'},
            {motion: ['scale(1.1)']},
            {motion: {from: 'scale(1)'}},
            {slides: [{alt: 'no src'}]},
            {slides: [{src: 'a.jpg', flip: 'sideways'}]},
        ])
        {
            expect(valid(config), JSON.stringify(config)).not.toEqual([]);
        }
    });

    test('covers every config setting the panel reads', () => {
        // Properties the panel upgrades are its settings. These four have no config key.
        const source = readFileSync(new URL('../src/image-panel.js', import.meta.url), 'utf8');
        const upgradable = JSON.parse(source.match(/const UPGRADABLE = (\[[^\]]*\])/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
        const attributeOnly = ['src', 'keyboard', 'swipe', 'pauseOnHover'];
        const settings = upgradable.filter(prop => !attributeOnly.includes(prop) && prop !== 'config');

        const properties = Object.keys(schema.$defs.config.properties).filter(key => !['$schema', 'basePath', 'slides'].includes(key));
        expect(properties.sort()).toEqual(settings.sort());

        const kebab = prop => prop.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        expect(Object.keys(schema['x-attributeOnly']).sort()).toEqual(attributeOnly.map(kebab).sort());
        for (const prop of settings)
        {
            expect(schema.$defs.config.properties[prop]['x-attribute'], prop).toBe(kebab(prop));
        }
    });
});

test.describe('authoring entry point', () => {
    test('exports the shared helpers', async () => {
        const authoring = await import('image-panel/authoring');
        for (const name of ['parseFocalPoint', 'parseFocalRange', 'placeFocalPoint', 'focalMotion', 'coverPanel', 'motionCoverZoom', 'clampEasing', 'readMetadata'])
        {
            expect(typeof authoring[name], name).toBe('function');
        }
        expect(authoring.parseFocalPoint('25% 40%')).toEqual([0.25, 0.4]);
        expect(authoring.parseFocalRange('40% 10%')).toEqual([0.4, 0.1]);
    });
});
