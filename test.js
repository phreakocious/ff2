// node test.js — runs background.js against a stub chrome API and checks the behaviour that has bitten us.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const store = {};
const calls = { created: [], activated: [], focused: [] };
const listeners = {};
let TABS = [];
let HISTORY = [];

const chrome = {
  storage: { local: {
    get: async (defaults) => Object.assign({}, defaults, JSON.parse(JSON.stringify(store))),
    set: async (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
  } },
  tabs: {
    query: async () => TABS.map((t) => Object.assign({}, t)),
    create: async (o) => { calls.created.push(o); },
    update: async (id) => { calls.activated.push(id); },
  },
  windows: { update: async (id) => { calls.focused.push(id); } },
  history: { search: async () => HISTORY.map((h) => Object.assign({}, h)) },
  omnibox: {
    onInputChanged: { addListener: (f) => { listeners.changed = f; } },
    onInputEntered: { addListener: (f) => { listeners.entered = f; } },
  },
};

const ctx = { chrome, console, URL };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/background.js', 'utf8'), ctx);

function tab(id, title, url, extra) { return Object.assign({ id, windowId: 1, title, url, status: 'complete' }, extra); }
function hist(url, title) { return { url, title, lastVisitTime: Date.now() - 3600e3, visitCount: 3 }; }
function reset() {
  for (const k of Object.keys(store)) delete store[k];
  calls.created.length = calls.activated.length = calls.focused.length = 0;
  ctx.ffFrecency = null;
  TABS = []; HISTORY = [];
}
const tick = () => new Promise((r) => setTimeout(r, 10));
// Values built inside the vm context have that realm's prototypes; compare by structure only.
const eq = (actual, expected) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('matcher backtracks to the contiguous run', () => {
  const m = ctx.ffFzfMatch('Hello', 'lo');
  eq(m.positions, [3, 4]);
  assert.ok(m.score > ctx.ffFzfMatch('Helxo', 'lo').score);
});

t('word-start match beats mid-word match', () => {
  assert.ok(ctx.ffFzfScore('foo bar', 'b') > ctx.ffFzfScore('foobar', 'b'));
});

t('widely scattered match is rejected', () => {
  const url = 'https://www.example.com/watch?v=dQw4w9WgXcQ&list=PLb1234567890&index=3&t=42s&c=1';
  assert.strictEqual(ctx.ffFzfScore(url, 'abc'), 0);
});

t('gap floor: a 10-char gap between two chars passes, a 15-char gap fails', () => {
  // mid-string so no start-of-text bonus: 16 + 16 - 3 - 9 = 20 >= floor 16; with 15 filler: 15 < 16
  assert.strictEqual(ctx.ffFzfScore('xa' + 'x'.repeat(10) + 'b', 'ab'), 20);
  assert.strictEqual(ctx.ffFzfScore('xa' + 'x'.repeat(15) + 'b', 'ab'), 0);
});

t('no subsequence means no match', () => {
  assert.strictEqual(ctx.ffFzfMatch('youtube', 'tux'), null);
});

t('highlight wraps the scored positions and escapes markup', () => {
  assert.strictEqual(ctx.ffHighlightText('Hello', ['lo']), 'Hel<match>lo</match>');
  assert.strictEqual(ctx.ffHighlightText('a<b', ['b']), 'a&lt;<match>b</match>');
  assert.strictEqual(ctx.ffHighlightText('Hello', ['zz']), 'Hello');
});

t('parse round-trips a URL that has its own fragment', () => {
  eq(ctx.ffParseSelected('https://x/p#a#12.34'), { url: 'https://x/p#a', windowId: 12, tabId: 34 });
  eq(ctx.ffParseSelected('https://x/p#a#url'), { url: 'https://x/p#a' });
  assert.strictEqual(ctx.ffParseSelected('plain words'), null);
});

t('empty query lists open tabs, pinned first', async () => {
  TABS = [tab(1, 'Alpha', 'https://a.com/'), tab(2, 'Beta', 'https://b.com/', { pinned: true })];
  const s = await ctx.ffSearchFor('');
  assert.deepStrictEqual(s.map((x) => x.content), ['https://b.com/#1.2', 'https://a.com/#1.1']);
});

t('selecting a tab whose URL has a fragment records frecency under the real URL', async () => {
  TABS = [tab(1, 'Mail', 'https://mail.example/u/0/#inbox')];
  listeners.entered('https://mail.example/u/0/#inbox#1.1');
  await tick();
  assert.deepStrictEqual(Object.keys(store.frecency), ['https://mail.example/u/0/#inbox']);
  assert.ok(ctx.ffFrecencyBonus('https://mail.example/u/0/#inbox') > 0);
  assert.deepStrictEqual(calls.activated, [1]);
  assert.deepStrictEqual(calls.focused, [1]);
});

t('Enter on the default row activates the top suggestion and records it', async () => {
  TABS = [tab(1, 'GitHub - repo', 'https://github.com/x/repo')];
  listeners.entered('git');
  await tick();
  assert.deepStrictEqual(calls.activated, [1]);
  assert.strictEqual(store.frecency['https://github.com/x/repo'].count, 1);
  assert.ok(!('' in store.frecency));
});

t('Enter on an empty query activates the top-ranked tab', async () => {
  TABS = [tab(1, 'Alpha', 'https://a.com/'), tab(2, 'Beta', 'https://b.com/', { pinned: true })];
  listeners.entered('');
  await tick();
  assert.deepStrictEqual(calls.activated, [2]);
});

t('selecting a history item opens a new tab', async () => {
  HISTORY = [hist('https://h.com/', 'Hist')];
  listeners.entered('https://h.com/#url');
  await tick();
  eq(calls.created, [{ url: 'https://h.com/' }]);
  assert.deepStrictEqual(calls.activated, []);
});

t('stale frecency entries are pruned on the next selection', async () => {
  store.frecency = { 'https://old.com/': { count: 5, lastUsed: Date.now() - 31 * 864e5 } };
  TABS = [tab(1, 'New', 'https://new.com/')];
  listeners.entered('https://new.com/#1.1');
  await tick();
  assert.deepStrictEqual(Object.keys(store.frecency), ['https://new.com/']);
});

t('search still works when storage fails', async () => {
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  try {
    TABS = [tab(1, 'Alpha', 'https://a.com/')];
    const s = await ctx.ffSearchFor('alpha');
    assert.strictEqual(s.length, 1);
  } finally { chrome.storage.local.get = get; }
});

t('recently focused tab outranks an identical stale tab', () => {
  const fresh = tab(1, 'Same title', 'https://same.com/a', { lastAccessed: Date.now() });
  const stale = tab(2, 'Same title', 'https://same.com/b', { lastAccessed: Date.now() - 7 * 864e5 });
  assert.ok(ctx.ffCalculateScoreWords(fresh, ['same']) > ctx.ffCalculateScoreWords(stale, ['same']));
});

t('history fills up to five rows, tabs first, without duplicating a tab URL', async () => {
  TABS = [tab(1, 'Dup', 'https://dup.com/')];
  HISTORY = [hist('https://dup.com/', 'Dup')].concat(Array.from({ length: 10 }, (_, i) => hist(`https://h${i}.com/`, `Dup ${i}`)));
  const s = await ctx.ffSearchFor('dup');
  assert.strictEqual(s.length, 5);
  assert.strictEqual(s[0].content, 'https://dup.com/#1.1');
  assert.strictEqual(s.filter((x) => x.content.startsWith('https://dup.com/')).length, 1);
  assert.ok(s[1].description.startsWith('<url>[History]</url>'));
});

t('a word that matches nothing excludes the item', async () => {
  TABS = [tab(1, 'Alpha', 'https://a.com/')];
  const s = await ctx.ffSearchFor('alpha zzz');
  assert.deepStrictEqual(s, []);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { reset(); await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message || e).split('\n')[0]); }
  }
  console.log(failed ? `${failed} of ${tests.length} failed` : `${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
