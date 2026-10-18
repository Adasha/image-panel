import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
    testDir: 'tests',
    fullyParallel: true,
    use: {baseURL: 'http://127.0.0.1:8123'},
    webServer: {
        command: 'npx esbuild --servedir=. --serve=127.0.0.1:8123',
        url: 'http://127.0.0.1:8123/tests/fixture.html',
        reuseExistingServer: !process.env.CI,
    },
    projects: [
        {name: 'chromium', use: devices['Desktop Chrome']},
        {name: 'firefox', use: devices['Desktop Firefox']},
    ],
});
