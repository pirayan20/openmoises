// Real-audio check against the running server and a real song in the library:
// every stem node advances in lockstep, tempo changes take effect at once, and the worklets keep up.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.env.TEST_URL || 'http://localhost:8000/#/library');
    await page.waitForFunction(() => library.playable().length > 0);
    const stems = await page.evaluate(() => {
      const s = library.playable().sort((a, b) => b.stems.length - a.stems.length)[0];
      engine.load(s, true);
      return s.stems.length;
    });
    await page.waitForFunction(() => engine.phase === 'playing', null, { timeout: 60000 });
    await page.evaluate(() => Object.values(engine.nodes).forEach(n => n.setUpdateInterval(0.05)));

    const sample = () => page.evaluate(() => ({
      t: engine.ctx.currentTime, pos: engine.pos(), inputs: Object.values(engine.nodes).map(n => n.inputTime),
    }));
    await page.waitForTimeout(1500);
    const a = await sample();
    await page.waitForTimeout(4000);
    const b = await sample();
    const spread = Math.max(...b.inputs) - Math.min(...b.inputs);
    const rate = (b.inputs[0] - a.inputs[0]) / (b.t - a.t);
    console.log(`stems=${stems} spread=${(spread * 1000).toFixed(1)}ms rate@100%=${rate.toFixed(3)}`);
    assert.ok(spread < 0.06, `stems stay within one update interval of each other (${spread})`);
    assert.ok(Math.abs(rate - 1) < 0.03, `worklets keep up in real time at 100% (${rate})`);

    const t0 = await page.evaluate(() => { const t = performance.now(); engine.retune({ tempo: 0.8, pitch: 2 }); return performance.now() - t; });
    await page.waitForTimeout(1000);
    const c = await sample();
    await page.waitForTimeout(4000);
    const d = await sample();
    const slow = (d.inputs[0] - c.inputs[0]) / (d.t - c.t);
    console.log(`retune call ${t0.toFixed(1)}ms rate@80%=${slow.toFixed(3)} posDrift=${((d.pos - d.inputs[0]) * 1000).toFixed(0)}ms`);
    assert.ok(t0 < 20, 'retune returns immediately, nothing is fetched or rendered');
    assert.ok(Math.abs(slow - 0.8) < 0.03, `stems play at 80% after retune (${slow})`);
    assert.ok(Math.abs(d.pos - d.inputs[0]) < 0.25, 'engine position tracks the audio');

    const fetches = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.includes('/stems/')).length);
    assert.equal(fetches, stems, 'each stem is fetched once, never re-rendered');
    assert.deepEqual(errors, []);
    console.log('PASS: real stems stay locked, tempo/key change is instant, worklets keep up, no re-fetch');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
