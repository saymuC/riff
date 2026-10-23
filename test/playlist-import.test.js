'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('async function handlePlaylistImport(');
const end = source.indexOf('const SPOTIFY_SCOPES', start);
assert.ok(start >= 0 && end > start);

function response() {
  return {
    status: 0,
    writeHead(status) { this.status = status; },
    end(body) { this.data = JSON.parse(body); }
  };
}

test('imports more than 1000 YouTube and YouTube Music entries without an extraction cap', async () => {
  for (const host of ['www.youtube.com', 'music.youtube.com']) {
    const calls = [];
    const context = {
      URL,
      logger: { error() {} },
      executeYtDlp: async (args) => {
        calls.push(args);
        return JSON.stringify({ title: 'Large playlist', playlist_count: 1201, entries: Array.from({ length: 1201 }, (_, i) => ({ id: `song-${i}`, title: `Song ${i}`, channel: 'Artist', url: `https://www.youtube.com/watch?v=song-${i}` })) });
      }
    };
    const handler = vm.runInNewContext(`${source.slice(start, end)}\nhandlePlaylistImport`, context);
    const res = response();
    await handler({}, res, `https://${host}/playlist?list=123`);
    assert.equal(res.status, 200);
    assert.equal(res.data.tracks.length, 1201);
    assert.equal(res.data.tracks[1200].title, 'Song 1200');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('--playlist-end'), false);
  }
});

test('SoundCloud hydration with only 300 of 1201 tracks falls back to the full extractor', async () => {
  let calls = 0;
  const hydrated = { hydratable: 'playlist', data: { track_count: 1201, tracks: Array.from({ length: 300 }, (_, i) => ({ id: i, title: `Song ${i}` })) } };
  const context = {
    URL,
    logger: { error() {} },
    fetch: async () => ({ text: async () => `<script>window.__sc_hydration = ${JSON.stringify([hydrated])};</script>` }),
    executeYtDlp: async (args) => {
      calls++;
      assert.equal(args.includes('--playlist-end'), false);
      return JSON.stringify({ playlist_count: 1201, entries: Array.from({ length: 1201 }, (_, i) => ({ id: i + 1, title: `Song ${i}`, webpage_url: `https://soundcloud.com/artist/song-${i}` })) });
    }
  };
  const handler = vm.runInNewContext(`${source.slice(start, end)}\nhandlePlaylistImport`, context);
  const res = response();
  await handler({}, res, 'https://soundcloud.com/artist/sets/large');
  assert.equal(calls, 1);
  assert.equal(res.status, 200);
  assert.equal(res.data.tracks.length, 1201);
});

test('does not report success if the extractor returns an incomplete playlist', async () => {
  const handler = vm.runInNewContext(`${source.slice(start, end)}\nhandlePlaylistImport`, {
    URL,
    logger: { error() {} },
    executeYtDlp: async () => JSON.stringify({ playlist_count: 1201, entries: Array.from({ length: 300 }, (_, i) => ({ id: i + 1, title: `Song ${i}` })) })
  });
  const res = response();
  await handler({}, res, 'https://www.youtube.com/playlist?list=123');
  assert.equal(res.status, 500);
  assert.match(res.data.error, /300 of 1201/);
});

test('Apple Music rejects a playlist when its public page contains only 300 of 1201 tracks', async () => {
  const appleStart = source.indexOf('async function handleAppleImport(');
  const appleEnd = source.indexOf('async function handlePlaylistImport(', appleStart);
  assert.ok(appleStart >= 0 && appleEnd > appleStart);
  const playlist = {
    type: 'playlist', name: 'Large playlist', trackCount: 1201,
    tracks: Array.from({ length: 300 }, (_, i) => ({ type: 'songs', title: `Song ${i}`, artistName: 'Artist' }))
  };
  const handler = vm.runInNewContext(`${source.slice(appleStart, appleEnd)}\nhandleAppleImport`, {
    logger: { error() {} },
    fetchHtmlWithRedirects: async () => ({ statusCode: 200, body: `<script type="application/json" id="serialized-server-data">${JSON.stringify(playlist)}</script>` })
  });
  const res = response();
  await handler({}, res, 'https://music.apple.com/us/playlist/large/pl.abc');
  assert.equal(res.status, 409);
  assert.match(res.data.error, /Export files/);
});
