import {test, expect} from '@playwright/test';

const image = page => page.locator('#panel [part~="slide"]:last-child [part~="image"]');
const osdValue = (page, field) => page.locator(`#osd-fields dt:text-is("${field}") + .source + dd`);
const osdSource = (page, field) => page.locator(`#osd-fields dt:text-is("${field}") + .source`);

let errors;

test.beforeEach(async ({page}) => {
    errors = [];
    page.on('pageerror', error => errors.push(error));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.goto('/demo/playground.html');
    await expect(page.locator('#osd-counter')).toHaveText('1 / 5');
});

test.afterEach(async () => {
    expect(errors).toEqual([]);
});

test('shows the current slide in the overlay, with where each field came from', async ({page}) => {
    await expect(osdValue(page, 'title')).toHaveText('Boat stall in Hạ Long Bay');
    await expect(osdSource(page, 'title')).toHaveText('json');
    await expect(page.locator('#osd-file')).toHaveText('HaLongBay-Woman-in-shop-boat.jpg');

    await page.locator('#show-osd').uncheck();
    await expect(page.locator('#osd')).toBeHidden();
});

test('marks fields read from the file, and drops them when metadata is off', async ({page}) => {
    await page.locator('#next').click();
    await expect(page.locator('#osd-counter')).toHaveText('2 / 5');
    // The second slide's JSON has no title, so any title came from the file
    const title = osdSource(page, 'title');
    await expect(title).toHaveText('file');

    await page.getByLabel('Read file metadata').uncheck();
    await expect(page.locator('#osd-counter')).toHaveText('2 / 5');
    await expect(title).toHaveText('—');
});

test('panel settings update the panel live', async ({page}) => {
    await page.locator('#fit').selectOption('contain');
    await expect(image(page)).toHaveCSS('object-fit', 'contain');
    await expect(page.locator('#panel')).toHaveAttribute('fit', 'contain');

    await page.locator('#interval').fill('3000');
    await expect(page.locator('#panel')).toHaveAttribute('interval', '3000');
    await expect(page.locator('output[for="interval"]')).toHaveText('3.0s');

    await page.getByLabel('Pause on hover').check();
    await expect(page.locator('#panel')).toHaveAttribute('pause-on-hover');
    await expect(page.locator('#code')).toContainText('pause-on-hover');
});

test('slide overrides apply to the slide on screen and appear in the code', async ({page}) => {
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveText('Play');

    await page.locator('#slide-flip').selectOption('horizontal');
    await expect(image(page)).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
    await expect(page.locator('#osd-counter')).toHaveText('1 / 5');
    await expect(page.locator('#code')).toContainText('"flip": "horizontal"');

    await page.locator('#reset-slide').click();
    await expect(image(page)).toHaveCSS('transform', 'none');
});

test('transport buttons drive the panel', async ({page}) => {
    await page.locator('#prev').click();
    await expect(page.locator('#osd-counter')).toHaveText('5 / 5');
    await expect(page.locator('#announcer')).toContainText('Slide 5 of 5');
    await expect(page.locator('#log li').first()).toContainText('api');
});
