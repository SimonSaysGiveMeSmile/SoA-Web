const assert = require('node:assert/strict');

module.exports = async function testMobileFullscreen(browser, url) {
    const errors = [];
    const open = async (options, setup) => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
        if (setup) await context.addInitScript(setup);
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(url);
        await page.waitForFunction(() => window._app?._snapshot?.tabs?.length);
        return { context, page };
    };
    const noFullscreen = () => {
        Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined, configurable: true });
        Object.defineProperty(Element.prototype, 'webkitRequestFullscreen', { value: undefined, configurable: true });
        localStorage.setItem('soa.m.installHint', 'dismissed');
    };

    // Real Chromium fullscreen, including an exit initiated by the browser.
    const chrome = await open();
    try {
        const page = chrome.page;
        const button = page.locator('#btn-fullscreen');
        const mic = page.locator('#btn-mic');
        await mic.click();
        await page.waitForFunction(() => window._app._voiceManagerId && !window._app._openingVoiceManager);
        await page.locator('#chat-input').fill('Keep this draft through fullscreen');
        await button.click();
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#topbar').isVisible(), true);
        assert.equal(await mic.isVisible(), true, 'voice stays accessible in full screen');
        assert.equal(await page.locator('#chat-input').inputValue(), 'Keep this draft through fullscreen');
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => document.getElementById('btn-fullscreen').getAttribute('aria-pressed') === 'false');
        await button.click();
        await page.waitForFunction(() => !!document.fullscreenElement);
        await button.click();
        await page.waitForFunction(() => !document.fullscreenElement);
        assert.equal(await page.locator('#app').evaluate(el => el.classList.contains('focus-mode')), false);

        // A blocked native request must explain the alternative, not silently
        // hide app controls or leave the toggle claiming it succeeded.
        await page.evaluate(() => {
            document.documentElement.requestFullscreen = () => Promise.reject(new Error('Denied'));
        });
        await button.click();
        await page.locator('#fullscreen-help').waitFor({ state: 'visible' });
        assert.match(await page.locator('#fullscreen-message').textContent(), /could not enter full screen/);
        assert.equal(await button.getAttribute('aria-pressed'), 'false');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#fullscreen-help').isVisible(), false);
    } finally { await chrome.context.close(); }

    const iphone = await open({ isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    }, noFullscreen);
    try {
        const page = iphone.page;
        const button = page.locator('#btn-fullscreen');
        const help = page.locator('#fullscreen-help');
        for (const [width, height] of [[390, 844], [320, 640], [844, 390]]) {
            await page.setViewportSize({ width, height });
            for (const id of ['btn-mic', 'btn-fullscreen', 'btn-overflow']) {
                const box = await page.locator('#' + id).boundingBox();
                assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${id} stays on-screen at ${width}px`);
            }
            await button.click();
            assert.equal(await help.isVisible(), true, 'dismissed banner cannot suppress requested instructions');
            assert.match(await help.textContent(), /Share/);
            assert.match(await help.textContent(), /Open as Web App/);
            assert.match(await help.textContent(), /Home Screen icon/);
            assert.equal(await page.locator('#topbar').isVisible(), true);
            assert.equal(await page.locator('#fullscreen-install').isVisible(), false, 'no fake install action on iPhone');
            assert.equal(await button.getAttribute('aria-pressed'), 'false');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.screenshot({ path: `/private/tmp/soa-mobile-fullscreen-iphone-${width}.png` });
            await page.locator('#fullscreen-close').click();
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#btn-overflow').click();
        await page.locator('#btn-focus').click();
        assert.equal(await page.locator('#topbar').isVisible(), false);
        await page.evaluate(() => window._app._installHint(true));
        assert.equal(await help.isVisible(), true, 'Focus mode cannot hide fullscreen guidance');
        await page.locator('#fullscreen-close').click();
        await page.locator('#focus-exit').click();
        assert.equal(await page.locator('#topbar').isVisible(), true);

        // Home Screen and App Store launches are already free of browser bars.
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
            window._app.fullscreen.sync();
            window._app._installHint(true);
        });
        assert.equal(await button.isVisible(), false);
        assert.equal(await help.isVisible(), false);
        assert.equal(await page.locator('#install-hint').isVisible(), false);

        // The new module must be cached so installation help survives offline.
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        assert.equal(await page.evaluate(async () => !!await caches.match(new URL('fullscreen.js', location.href))), true);
        const manifest = await (await page.request.get(new URL('manifest.webmanifest', page.url()).href)).json();
        assert.equal(manifest.display, 'fullscreen');
    } finally { await iphone.context.close(); }

    const android = await open({ isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36',
    }, noFullscreen);
    try {
        const page = android.page;
        await page.locator('#btn-fullscreen').click();
        const help = page.locator('#fullscreen-help');
        assert.match(await help.textContent(), /Open this page in Chrome/);
        assert.ok(!(await help.textContent()).includes('Safari'), 'Android in-app browsers get Android directions');
        for (const outcome of ['dismissed', 'accepted']) {
            const prevented = await page.evaluate(outcome => {
                const event = new Event('beforeinstallprompt', { cancelable: true });
                window.installPrompts = 0;
                event.prompt = async () => { window.installPrompts++; };
                event.userChoice = Promise.resolve({ outcome });
                window.dispatchEvent(event);
                return event.defaultPrevented;
            }, outcome);
            assert.equal(prevented, true);
            await page.locator('#fullscreen-install').click();
            await page.waitForFunction(() => document.getElementById('fullscreen-install').hidden);
            assert.equal(await page.evaluate(() => window.installPrompts), 1);
            assert.equal(await help.isVisible(), true);
            assert.match(await page.locator('#fullscreen-message').textContent(), outcome === 'accepted' ? /Home Screen/ : /later/);
        }
        await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
        assert.match(await page.locator('#fullscreen-message').textContent(), /Installed/);
        await page.locator('#fullscreen-close').click();
        assert.equal(await page.locator('#btn-fullscreen').isVisible(), true, 'installing does not pretend the current browser tab is fullscreen');
    } finally { await android.context.close(); }
    assert.deepEqual(errors, []);
    console.log('Mobile fullscreen: native entry/exit, voice access, draft preservation, denied requests, iPhone setup, installed launch, Android install prompts, safe layouts and offline module cache passed.');
};
