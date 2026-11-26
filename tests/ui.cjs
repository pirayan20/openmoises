const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const songs = ['a', 'b', 'c'].map((id, i) => ({
      id, title: `Song ${i + 1}`, artist: 'Test artist', status: 'done', duration: 8,
      stems: ['bass', 'drums', 'vocals', 'other'], analysis: { tonic: 0, mode: 'major', bpm: 120 },
    }));
    const wav = Buffer.alloc(44 + 44100 * 8 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    await page.route('**/api/songs', route => route.fulfill({ json: songs }));
    await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
    await page.route('**/stems/**', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await page.goto(process.env.TEST_URL || 'http://localhost:8000');
    await page.locator('#homeGrid .card').first().waitFor();
    await page.locator('#navLibrary').click();
    await page.locator('#grid .card').first().waitFor();
    await page.locator('#libSearch').fill('song 2');
    await page.waitForFunction(() => [...document.querySelectorAll('#grid .card:not([hidden])')].map(c => c.dataset.id).join() === 'b');
    assert.equal(await page.locator('#hero').isVisible(), false, 'highlight steps aside while searching');
    assert.equal(await page.locator('#gridTitle').textContent(), 'Results');
    await page.locator('#libSearch').fill('  TEST ARTIST  ');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card:not([hidden])').length === 3);
    await page.locator('#libSearch').fill('nothing like this');
    await page.locator('#libNone').waitFor({ state: 'visible' });
    await page.locator('#libSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card:not([hidden])').length === 3 && !document.querySelector('#hero').hidden);
    assert.ok(await page.locator('#libraryView').isVisible());
    assert.equal(await page.locator('#home').isVisible(), false);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('#libSearch').fill('song 2');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card:not([hidden])').length === 1);
    assert.ok(await page.locator('#main').evaluate(el => el.scrollWidth <= el.clientWidth), 'Library search fits mobile');
    await page.locator('#libSearch').fill('');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.locator('#grid .card').first().waitFor();
    assert.ok(await page.locator('#libraryView').isVisible(), 'Library deep link survives reload');
    await page.locator('#heroStudio').click();
    await page.waitForFunction(() => !document.querySelector('#studio').inert);
    await page.locator('#closeStudio').click();
    await page.waitForFunction(() => location.hash === '#/library' && getComputedStyle(document.querySelector('#studio')).visibility === 'hidden');
    assert.ok(await page.locator('#libraryView').isVisible(), 'Closing Studio lands on Library');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'heroStudio', 'Focus returns to the button that opened Studio');
    await page.locator('#navHome').click();
    await page.locator('#modelPicker summary').click();
    const menuBounds = await page.locator('#modelOptions').boundingBox();
    assert.ok(menuBounds.width <= 320 && menuBounds.height <= 280, 'Model menu stays compact');
    assert.equal(await page.locator('#sidebar #navStudio').count(), 0);
    assert.equal(await page.locator('.song-studio, .btn-studio').count(), 0);
    assert.equal(await page.locator('#modelOptions input:checked').inputValue(), 'htdemucs_ft');
    await page.locator('#modelOptions input[value="htdemucs_6s"]').check();
    assert.equal(await page.locator('#modelLabel').textContent(), 'Demucs 6 stems');
    assert.equal(await page.locator('#modelPicker').evaluate(el => el.open), false);
    await page.locator('#modelPicker summary').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modelPicker').evaluate(el => el.open), false);
    let submitted;
    await page.route('**/api/separate', route => {
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { id: 'd' } });
    });
    await page.locator('#url').fill('https://www.youtube.com/watch?v=test');
    await page.locator('#addBtn').click();
    await page.waitForFunction(() => location.hash === '#/library');
    assert.equal(submitted.model, 'htdemucs_6s');
    await page.locator('#navHome').click();
    assert.equal(await page.locator('#sidebarNarrower, #sidebarWider').count(), 0);

    await page.locator('#sidebarResize').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#sidebarResize').getAttribute('aria-valuenow'), '250');
    const handle = await page.locator('#sidebarResize').boundingBox();
    await page.mouse.move(handle.x + 5, handle.y + 100);
    await page.mouse.down();
    await page.mouse.move(handle.x + 85, handle.y + 100);
    await page.mouse.up();
    assert.equal(await page.locator('#sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width)), 330);
    await page.reload();
    assert.equal(await page.locator('#sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width)), 330);

    await page.locator('#homeGrid .card-play').first().click();
    await page.waitForFunction(() => engine.phase === 'playing');
    await page.locator('#playBtn').click();
    const generation = await page.evaluate(() => engine.gen);
    const openStudio = async selector => {
      await page.locator(selector).click();
      await page.waitForFunction(() => !document.querySelector('#studio').inert);
      await page.locator('#studio').evaluate(async el => {
        await Promise.all(el.getAnimations().map(animation => animation.finished));
      });
    };
    await openStudio('#barStudio');
    const studio = await page.locator('#studio').boundingBox();
    assert.equal(studio.width, 1440 - 72, 'Studio is a full page next to the rail');
    assert.equal(studio.x, 72);
    assert.ok(await page.locator('#main').evaluate(el => el.inert));
    assert.equal(await page.locator('#sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width)), 72, 'Sidebar collapses to a rail');
    assert.ok(await page.locator('#lib .lib-item').first().isVisible(), 'Rail keeps the library covers');
    assert.equal(await page.locator('#lib .lib-text').first().isVisible(), false);
    assert.equal(await page.evaluate(() => engine.gen), generation, 'Opening Studio preserves loaded audio');
    let keyPut;
    await page.route('**/api/songs/*/key', route => { keyPut = JSON.parse(route.request().postData()); route.fulfill({ json: {} }); });
    assert.equal(await page.locator('#stKeySel option:checked').textContent(), 'C major (detected)');
    await page.locator('#stKeySel').selectOption('9:minor');
    await page.waitForFunction(() => document.querySelector('#keyV').textContent.startsWith('Am'));
    assert.deepEqual(keyPut, { tonic: 9, mode: 'minor' }, 'Picked key is saved on the server');
    await page.locator('#stKeySel').selectOption('');
    await page.waitForFunction(() => document.querySelector('#keyV').textContent.startsWith('C'));
    assert.equal(keyPut, null, 'Choosing detected clears the saved key');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'closeStudio');
    assert.ok(await page.locator('#tracksScroll').evaluate(el => el.scrollWidth <= el.clientWidth), 'Full-page Studio fits the timeline; narrow screens scroll it (checked at 390px)');
    await page.locator('#tracksScroll').evaluate(el => { el.scrollLeft = 280; });
    const wave = await page.locator('.wave').first().boundingBox();
    const scroller = await page.locator('#tracksScroll').boundingBox();
    const x = scroller.x + scroller.width * 0.65;
    await page.mouse.click(x, wave.y + wave.height / 2);
    assert.ok(Math.abs(await page.evaluate(() => engine.pos()) - (x - wave.x) / wave.width * 8) < 0.1);
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('wave')), 'Click focuses waveform');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => engine.phase === 'playing');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => engine.phase === 'paused');
    await page.keyboard.down('Space');
    await page.waitForFunction(() => engine.phase === 'playing');
    await page.keyboard.down('Space');
    assert.equal(await page.evaluate(() => engine.phase), 'playing', 'Held Space does not toggle repeatedly');
    await page.keyboard.up('Space');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => engine.phase === 'paused');
    await page.mouse.move(x - 80, wave.y + wave.height / 2);
    await page.mouse.down();
    await page.mouse.move(x + 20, wave.y + wave.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.ok(await page.evaluate(() => engine.loop.on && engine.loop.b > engine.loop.a));
    for (const selector of ['#closeStudio', '.ms[data-act="mute"]', '#tracksScroll', '.lane input[type="range"]']) {
      const before = await page.evaluate(() => JSON.stringify(engine.mix));
      await page.locator(selector).first().focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => engine.phase === 'playing');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => engine.phase === 'paused');
      assert.equal(await page.evaluate(() => route.view), 'studio', 'Space does not activate focused Studio button');
      assert.equal(await page.evaluate(() => JSON.stringify(engine.mix)), before, 'Space does not change stem controls');
    }
    await page.locator('#playBtn').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => engine.phase === 'playing');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => engine.phase === 'paused');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#studio')).visibility === 'hidden');
    assert.equal(await page.evaluate(() => location.hash), '#/', 'Esc returns to Home when opened from Home');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'barStudio');
    assert.equal(await page.evaluate(() => engine.gen), generation);

    await page.locator('#navHome').click();
    await openStudio('#homeStudio');
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.locator('#studio').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const closeBounds = await page.locator('#closeStudio').boundingBox();
    assert.ok(closeBounds.y >= 0 && closeBounds.y < 64, 'Close stays pinned while Studio scrolls');
    await page.locator('#closeStudio').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#studio')).visibility === 'hidden');
    assert.equal(await page.evaluate(() => location.hash), '#/');
    assert.ok(await page.locator('#home').isVisible());
    assert.equal(await page.evaluate(() => engine.gen), generation, 'Closing Studio preserves audio');
    assert.equal(await page.locator('#sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width)), 330, 'Sidebar width comes back after Studio');

    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#navHome').click();
      await page.locator('#modelPicker summary').click();
      assert.ok(await page.locator('#modelOptions').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      await page.keyboard.press('Escape');
      assert.ok(await page.locator('#barStudio').isVisible(), 'Player Studio button stays visible on mobile');
      await openStudio('#barStudio');
      const panel = await page.locator('#studio').boundingBox();
      const bar = await page.locator('#bar').boundingBox();
      const left = width <= 600 ? 0 : 72;
      assert.equal(panel.x, left);
      assert.equal(panel.width, width - left);
      assert.ok(panel.y + panel.height <= bar.y + 1, 'Studio leaves player accessible');
      assert.ok(await page.locator('#bar').evaluate(el => el.scrollWidth <= el.clientWidth), 'Player controls fit viewport');
      assert.ok(await page.locator('#main').evaluate(el => el.inert));
      assert.equal(await page.locator('#sidebar').evaluate(el => el.inert), width <= 600);
      assert.ok(await page.locator('#studio').evaluate(el => el.scrollWidth <= el.clientWidth), 'Only timeline scrolls horizontally');
      if (width === 390) {
        await page.locator('#tracksScroll').scrollIntoViewIfNeeded();
        await page.locator('#tracksScroll').evaluate(el => { el.scrollLeft = 0; });
        const bounds = await page.locator('#tracksScroll').boundingBox();
        const client = await page.context().newCDPSession(page);
        const y = bounds.y + 55, start = bounds.x + bounds.width - 20;
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
        for (const distance of [30, 60, 100]) {
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start - distance, y }] });
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(() => document.querySelector('#tracksScroll').scrollLeft > 0);
        await client.detach();
      }
      await page.locator('#closeStudio').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#studio')).visibility === 'hidden');
      assert.equal(await page.locator('#main').evaluate(el => el.inert), false);
      assert.ok(await page.locator('#main').evaluate(el => el.scrollWidth <= el.clientWidth), 'Home fits viewport');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.locator('#navHome').click();
    await openStudio('#homeStudio');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelector('#studio').getBoundingClientRect().width === innerWidth - 72);
    await page.locator('#next').click();
    await page.waitForFunction(() => location.hash === '#/studio/b' && engine.phase === 'playing');
    await page.locator('#playBtn').click();
    await page.reload();
    await page.waitForFunction(() => engine.phase === 'paused' && !document.querySelector('#studio').inert);
    assert.equal(await page.locator('#stTitle').textContent(), 'Song 2');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#studio').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.deepEqual(errors, []);
    console.log('PASS: Home/Library routes, model selection/submission, drag/reload, full-page Studio with rail/close/focus, mobile/tablet layout, playback, deep links, scroll/seek/loop, reduced motion');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
