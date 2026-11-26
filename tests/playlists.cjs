// Playlist flows against a stateful fake of /api/playlists: sidebar limits, create and rename,
// playing a setlist with its saved settings, auto-advance with the up-next toast, saving from
// Studio and from a song card, reorder, remove and delete.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    const ids = 'abcdefghij'.split('');
    const songs = ids.map((id, i) => ({
      id, title: `Song ${i + 1}`, artist: 'Test artist', status: 'done', duration: 3,
      stems: ['bass', 'drums', 'vocals', 'other'], analysis: { tonic: 0, mode: 'major', bpm: 120 },
    }));
    const seconds = 3, wav = Buffer.alloc(44 + 44100 * seconds * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

    const noBass = { bass: { vol: 0, mute: false, solo: false }, drums: { vol: 1, mute: false, solo: false }, vocals: { vol: 1, mute: false, solo: false }, other: { vol: 1, mute: false, solo: false } };
    let seq = 100;
    const newId = () => (seq++).toString(16) + 'ff';
    let store = [
      { id: 'a1', name: 'Gig', createdAt: 1, entries: [
        { id: 'e1', songId: 'a', tempo: 0.9, pitch: 2, mix: noBass, loop: null },
        { id: 'e2', songId: 'b', tempo: 1, pitch: 0, mix: null, loop: null },
      ] },
      ...[2, 3, 4, 5, 6].map(n => ({ id: `a${n}`, name: `List ${n}`, createdAt: n, entries: [] })),
    ];
    const calls = [];
    await page.route('**/api/songs', route => route.fulfill({ json: songs }));
    await page.route('**/stems/**', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await page.route(/\/api\/playlists(\/[0-9a-f]+)?$/, route => {
      const req = route.request(), id = req.url().match(/playlists\/([0-9a-f]+)$/)?.[1], body = JSON.parse(req.postData() || 'null');
      calls.push({ method: req.method(), id, body });
      const withIds = entries => entries.map(e => ({ tempo: 1, pitch: 0, mix: null, loop: null, ...e, id: e.id ?? newId() }));
      if (req.method() === 'GET') return route.fulfill({ json: store });
      if (req.method() === 'POST') {
        const pl = { id: newId(), name: body.name, createdAt: Date.now(), entries: withIds(body.entries ?? []) };
        store = [...store, pl];
        return route.fulfill({ json: pl });
      }
      if (req.method() === 'PUT') {
        const pl = store.find(p => p.id === id);
        Object.assign(pl, body.name ? { name: body.name } : {}, body.entries ? { entries: withIds(body.entries) } : {});
        return route.fulfill({ json: pl });
      }
      store = store.filter(p => p.id !== id);
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto((process.env.TEST_URL || 'http://localhost:8000') + '/#/library');
    await page.locator('#plSide li').first().waitFor();

    // sidebar shows at most 5 playlists and 8 songs
    assert.equal(await page.locator('#plSide li').count(), 5);
    assert.equal(await page.locator('#plMore').textContent(), 'Show all 6');
    await page.locator('#plMore').click();
    await page.waitForFunction(() => document.querySelectorAll('#plSide li').length === 6);
    await page.locator('#plMore').click();
    await page.waitForFunction(() => document.querySelectorAll('#plSide li').length === 5);
    assert.equal(await page.locator('#lib li').count(), 8);
    assert.equal(await page.locator('#libMore').textContent(), 'All 10 songs');

    // + makes a playlist, opens it, and the name is editable in place
    await page.locator('[data-act=newPlaylist]').click();
    await page.waitForFunction(() => location.hash.startsWith('#/playlist/') && document.activeElement.id === 'plName');
    assert.equal(await page.locator('#plName').inputValue(), 'Setlist 7');
    await page.locator('#plName').fill('Warm ups');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => playlists.items.some(p => p.name === 'Warm ups'));
    assert.ok(await page.locator('#plEmpty').isVisible(), 'empty playlist explains how to add songs');

    // "Add songs" picks from the library popup: search, tick in any order, add in that order
    await page.locator('[data-act=pickerOpen]').click();
    await page.locator('#picker').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pickerList li').count(), 10);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#picker').open);
    await page.locator('[data-act=pickerOpen]').click();
    await page.locator('#pickerSearch').fill('song 1');
    assert.deepEqual(await page.locator('#pickerList li:not([hidden]) .pl-title').allTextContents(), ['Song 1', 'Song 10']);
    await page.locator('#pickerList input[value=j]').check();
    await page.locator('#pickerSearch').fill('zzz');
    assert.ok(await page.locator('#pickerNone').isVisible(), 'says when nothing matches');
    await page.locator('#pickerSearch').fill('');
    await page.locator('#pickerList input[value=c]').check();
    assert.equal(await page.locator('#pickerAdd').textContent(), 'Add 2 songs');
    await page.locator('#pickerAdd').click();
    await page.waitForFunction(() => playlists.items.find(p => p.name === 'Warm ups')?.entries.map(e => e.songId).join() === 'j,c');
    assert.match(await page.locator('#toast').textContent(), /Added 2 songs to Warm ups/);
    await page.waitForFunction(() => document.querySelectorAll('#plList .pl-row').length === 2);
    await page.locator('[data-act=pickerOpen]').click();
    assert.equal(await page.locator('#pickerList li:has(input[value=j]) .chip').textContent(), 'In playlist');
    await page.locator('#picker button[value=cancel]').first().click();

    // a setlist row shows how each song opens
    await page.locator('#plSide a[href="#/playlist/a1"]').click();
    await page.waitForFunction(() => document.querySelector('#plName').value === 'Gig' && document.querySelector('#plList .pl-sub')?.textContent.startsWith('D'));
    const chips = await page.locator('#plList .pl-row .chips').allTextContents();
    assert.match(chips[0], /90%.*Key \+2.*Play along/);
    assert.match(chips[1], /100%.*Key 0.*Bass practice/);
    assert.match(await page.locator('#plList .pl-row .pl-sub').first().textContent(), /^D · 108 BPM/, 'key and BPM shown as they will sound');

    // Play opens the first song with its saved settings, then moves on to the next with its own
    await page.locator('#plPlay').click();
    await page.waitForFunction(() => engine.phase === 'playing' && engine.song.id === 'a');
    assert.deepEqual(await page.evaluate(() => [engine.want.tempo, engine.want.pitch, engine.preset()]), [0.9, 2, 'noBass']);
    await page.locator('#upNext').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#upNextTitle').textContent(), 'Song 2');
    await page.waitForFunction(() => engine.song.id === 'b' && engine.phase === 'playing', null, { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => [engine.want.tempo, engine.want.pitch, engine.preset()]), [1, 0, 'bass']);
    assert.ok(await page.locator('#plList .pl-row[data-index="1"][data-current]').count(), 'current row is marked');
    await page.waitForFunction(() => engine.phase === 'paused' && !queue, null, { timeout: 15000 });

    // Studio: save the song with what's dialled in right now
    await page.evaluate(() => { location.hash = '#/studio/c'; });
    await page.waitForFunction(() => engine.song?.id === 'c' && engine.phase === 'paused');
    await page.locator('[data-act=pitch][data-d="-1"]').click();
    await page.locator('#presets [data-preset=all]').click();
    await page.evaluate(() => engine.setLoop(1, 2));
    await page.locator('#saveSet').click();
    await page.locator('#plMenu').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#plMenu').isVisible(), false, 'Esc closes the menu');
    await page.locator('#saveSet').click();
    await page.locator('#plMenu [data-id=a1]').click();
    await page.waitForFunction(() => playlists.get('a1').entries.length === 3);
    const saved = store.find(p => p.id === 'a1').entries[2];
    assert.equal(saved.songId, 'c');
    assert.equal(saved.pitch, -1);
    assert.deepEqual(saved.loop, { on: true, a: 1, b: 2 });
    assert.ok(Object.values(saved.mix).every(m => m.vol === 1), 'full mix saved');
    assert.match(await page.locator('#toast').textContent(), /Saved to Gig/);
    await page.keyboard.press('Escape');

    // song card +: add with default settings to a new setlist
    await page.waitForFunction(() => location.hash.startsWith('#/playlist/'));
    await page.locator('#navLibrary').click();
    await page.locator('#grid .card[data-id=d]').hover();
    await page.locator('#grid .card[data-id=d] [data-act=addTo]').click();
    await page.locator('#plMenu [data-act=menuPick][data-id=""]').click();
    await page.waitForFunction(() => playlists.items.some(p => p.name === 'Setlist 8'));
    assert.deepEqual(store.find(p => p.name === 'Setlist 8').entries.map(e => [e.songId, e.mix, e.loop]), [['d', null, null]]);

    // reorder by dragging, then remove a row
    await page.evaluate(() => { location.hash = '#/playlist/a1'; });
    await page.waitForFunction(() => document.querySelectorAll('#plList .pl-row').length === 3);
    await page.locator('#plList .pl-row[data-index="2"]').dragTo(page.locator('#plList .pl-row[data-index="0"]'));
    await page.waitForFunction(() => playlists.get('a1').entries.map(e => e.songId).join() === 'c,a,b');
    await page.locator('#plList .pl-row[data-index="0"]').hover();
    await page.locator('#plList .pl-row[data-index="0"] [data-act=plRemove]').click();
    await page.waitForFunction(() => playlists.get('a1').entries.map(e => e.songId).join() === 'a,b');

    // delete the playlist; songs stay
    page.once('dialog', d => d.accept());
    await page.locator('[data-act=plDelete]').click();
    await page.waitForFunction(() => location.hash === '#/library' && !playlists.get('a1'));
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
    assert.equal(await page.locator('#grid .card').count(), 10);

    assert.deepEqual(errors, []);
    console.log('PASS: sidebar limits, create/rename, add-songs picker, setlist settings restore, auto-advance + up next, save from Studio and card, reorder, remove, delete');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
