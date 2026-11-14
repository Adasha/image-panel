// Run by `npm version` (the "version" script), after package.json is bumped and before the commit.
// Turns the changelog's Unreleased section into a dated release section and updates the compare links.
import {readFileSync, writeFileSync} from 'node:fs';

const REPO = 'https://github.com/Adasha/image-panel';
const FILE = new URL('../CHANGELOG.md', import.meta.url);

const {version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const date = new Date().toISOString().slice(0, 10);
let text = readFileSync(FILE, 'utf8');

const fail = message => { console.error(`changelog: ${message}`); process.exit(1); };

if (text.includes(`## [${version}]`)) fail(`${version} already has a section.`);

const unreleased = text.match(/^## \[Unreleased\][ \t]*\n([\s\S]*?)(?=^## \[|^\[Unreleased\]:)/m);
if (!unreleased) fail('no "## [Unreleased]" section found.');
if (!unreleased[1].trim()) fail('the Unreleased section is empty. Note the changes before releasing.');

const link = text.match(/^\[Unreleased\]: .*\/compare\/v(.+?)\.\.\.HEAD$/m);
if (!link) fail('no "[Unreleased]: …/compare/vX...HEAD" link found.');
const previous = link[1];

text = text
    .replace(/^## \[Unreleased\][ \t]*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`)
    .replace(link[0], `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n[${version}]: ${REPO}/compare/v${previous}...v${version}`);

writeFileSync(FILE, text);
console.log(`changelog: released ${version} (${date}), previous v${previous}.`);
