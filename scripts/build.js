import * as esbuild from 'esbuild';

const serve = process.argv.includes('--serve');

const common = {
    entryPoints: ['src/image-panel.js'],
    bundle: true,
    minify: true,
    sourcemap: true,
    target: 'es2022',
    legalComments: 'inline',
    logLevel: 'info',
};

const builds = [
    // Classic <script> build: wrapped so nothing leaks into the global scope
    {...common, format: 'iife', outfile: 'dist/image-panel.js'},
    // ES module build for `import`
    {...common, format: 'esm', outfile: 'dist/image-panel.esm.js'},
];

if (serve)
{
    const [classic, ...rest] = await Promise.all(builds.map(options => esbuild.context(options)));
    await Promise.all([classic, ...rest].map(context => context.watch()));
    await classic.serve({servedir: '.', port: 8000});
    console.log('Demo: http://localhost:8000/demo/');
}
else
{
    await Promise.all(builds.map(options => esbuild.build(options)));
}
