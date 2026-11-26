const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/api/songs', route => route.fulfill({ json: [{ id: 'a', title: 'Test', status: 'done', stems: ['bass'], duration: 2, analysis: { tonic: 0, mode: 'major', bpm: 120 } }] }));
    const wav = Buffer.alloc(44 + 44100 * 4);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    await page.route('**/stems/**', route => route.fulfill({ body: wav, contentType: 'audio/wav' }));
    await page.goto(process.env.TEST_URL || 'http://localhost:8000');
    await page.locator('#homeStudio[href]').waitFor();
    const sample = async fraction => page.evaluate(async fraction => {
      const animations = [document.body, document.querySelector('#studio')].flatMap(node => node.getAnimations());
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = animation.effect.getTiming().duration * fraction;
      }
      await new Promise(requestAnimationFrame);
      return {
        side: document.querySelector('#sidebar').getBoundingClientRect().width,
        panelLeft: document.querySelector('#studio').getBoundingClientRect().left,
        animations: animations.length,
      };
    }, fraction);
    const finish = () => page.evaluate(() => { for (const el of [document.body, document.querySelector('#studio')]) for (const a of el.getAnimations()) a.finish(); });

    await page.locator('#homeStudio').click();
    await page.waitForFunction(() => document.body.hasAttribute('data-studio'));
    const middle = await sample(0.5);
    assert.ok(middle.animations > 0, 'Opening animates');
    assert.ok(middle.side < 240 && middle.side > 72, 'Sidebar shrinks to the rail during the slide');
    assert.ok(middle.panelLeft > 72 && middle.panelLeft < 1440, 'Studio slides in');
    await finish();
    assert.equal((await sample(1)).side, 72);

    await page.locator('#closeStudio').click();
    await page.waitForFunction(() => !document.body.hasAttribute('data-studio'));
    const closing = await sample(0.5);
    assert.ok(closing.animations > 0, 'Closing must animate instead of disappearing');
    assert.ok(closing.panelLeft > 72 && closing.panelLeft < 1440, 'Closing panel stays visible during slide');
    await finish();
    assert.equal(await page.locator('#studio').evaluate(el => el.inert), true);
    assert.equal((await sample(1)).side, 240, 'Sidebar returns to its width');
    assert.equal(await page.evaluate(() => location.hash), '#/', 'Closing Studio returns to Home');

    await page.locator('#navHome').click();
    await page.locator('#homeStudio').click();
    await page.waitForFunction(() => document.body.hasAttribute('data-studio'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.hasAttribute('data-studio'));
    await page.locator('#navHome').click();
    await page.locator('#homeStudio').click();
    await page.waitForFunction(() => document.body.hasAttribute('data-studio'));
    await page.locator('#studio').evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)); });
    assert.equal(Math.round((await page.locator('#studio').boundingBox()).x), 72);
    assert.equal(await page.locator('#studio').evaluate(el => el.inert), false);
    console.log('PASS: Studio opens full page, sidebar animates to rail and back, interrupted transitions recover');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
