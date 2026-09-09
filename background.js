var FF_MAX_SUGGESTIONS = 5;      // omnibox rows Chrome will show for an extension
var FF_MAX_MATCHLENGTH = 1000;   // characters of a title/URL the matcher looks at
var FF_HISTORY_DAYS = 90;
var FF_FRECENCY_KEEP_DAYS = 30;
var FF_DEBUGGING = false;

var ffFrecency = null;   // url -> {count, lastUsed}; null until loaded from storage

function ffEscapeHtml(unsafe) {
  return unsafe.replace(/&/g, "&amp;")
               .replace(/</g, "&lt;")
               .replace(/>/g, "&gt;")
               .replace(/"/g, "&quot;")
               .replace(/'/g, "&#039;");
}

function ffGetHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

// --- fzf-style matching (fzf v2 constants, affine gap penalty) ---

var FF_SCORE_MATCH = 16;
var FF_GAP_START = -3;
var FF_GAP_EXTEND = -1;
var FF_BONUS_BOUNDARY = 8;
var FF_BONUS_CAMEL = 7;
var FF_BONUS_CONSECUTIVE = 4;
var FF_BONUS_FIRST_CHAR = 2;   // multiplier on the first pattern char's bonus

// 0 = non-word, 1 = lower/caseless letter, 2 = upper, 3 = digit
function ffCharClass(ch) {
  if (/\p{Ll}/u.test(ch)) return 1;
  if (/\p{Lu}/u.test(ch)) return 2;
  if (/\p{N}/u.test(ch)) return 3;
  if (/\p{L}/u.test(ch)) return 1;
  return 0;
}

function ffBonusAt(prevClass, currClass) {
  if (prevClass === 0) return FF_BONUS_BOUNDARY;
  if (prevClass === 1 && currClass === 2) return FF_BONUS_CAMEL;
  if (prevClass !== 3 && currClass === 3) return FF_BONUS_CAMEL;
  return 0;
}

// Best alignment of pattern as a subsequence of text. Returns {score, positions} or null.
function ffFzfMatch(text, pattern) {
  var m = pattern.length;
  if (m === 0) return null;
  text = text.slice(0, FF_MAX_MATCHLENGTH);
  var n = text.length;
  var tl = text.toLowerCase(), pl = pattern.toLowerCase();

  // Quick reject: the pattern must be a subsequence at all.
  for (var q = 0, p = 0; q < n && p < m; q++) if (tl[q] === pl[p]) p++;
  if (p < m) return null;

  var bonus = new Array(n), prevClass = 0;
  for (var j = 0; j < n; j++) {
    var cls = ffCharClass(text[j]);
    bonus[j] = ffBonusAt(prevClass, cls);
    prevClass = cls;
  }

  // E[i][j]: best score with pattern[i] at text[j].
  // G[i][j]: best score with pattern[i] somewhere before j and text[j] skipped (inside a gap).
  var E = [], G = [];
  for (var i = 0; i < m; i++) {
    var e = new Array(n).fill(-Infinity), g = new Array(n).fill(-Infinity);
    for (j = i; j < n; j++) {
      if (j > 0) g[j] = Math.max(e[j - 1] + FF_GAP_START, g[j - 1] + FF_GAP_EXTEND);
      if (tl[j] !== pl[i]) continue;
      if (i === 0) {
        e[j] = FF_SCORE_MATCH + bonus[j] * FF_BONUS_FIRST_CHAR;
      } else {
        e[j] = FF_SCORE_MATCH + Math.max(
          E[i - 1][j - 1] + Math.max(bonus[j], FF_BONUS_CONSECUTIVE),
          G[i - 1][j - 1] + bonus[j]);
      }
    }
    E.push(e); G.push(g);
  }

  var last = E[m - 1], best = -Infinity, bj = -1;
  for (j = m - 1; j < n; j++) if (last[j] > best) { best = last[j]; bj = j; }
  // Gap penalties must leave at least half the base match value, or the match is junk.
  if (best < FF_SCORE_MATCH * m / 2) return null;

  // Trace back which text positions produced the best score.
  var positions = new Array(m);
  j = bj;
  for (i = m - 1; i >= 0; i--) {
    positions[i] = j;
    if (i === 0) break;
    var consecutive = E[i - 1][j - 1] + Math.max(bonus[j], FF_BONUS_CONSECUTIVE);
    var gapped = G[i - 1][j - 1] + bonus[j];
    j--;
    if (consecutive >= gapped) continue;
    while (G[i - 1][j] !== E[i - 1][j - 1] + FF_GAP_START) j--;   // still inside the gap
    j--;
  }
  return {score: best, positions: positions};
}

// Score > 0 on a match, 0 otherwise.
function ffFzfScore(text, pattern) {
  var match = ffFzfMatch(text, pattern);
  return match ? match.score : 0;
}

// Wrap the matched characters of every word in <match>, escaping the rest for the omnibox.
function ffHighlightText(text, words) {
  var marked = [];
  words.forEach(function(word) {
    var match = ffFzfMatch(text, word);
    if (match) match.positions.forEach(function(pos) { marked[pos] = true; });
  });
  var out = "", open = false;
  for (var i = 0; i < text.length; i++) {
    if (!!marked[i] !== open) {
      open = !open;
      out += open ? "<match>" : "</match>";
    }
    out += ffEscapeHtml(text[i]);
  }
  return open ? out + "</match>" : out;
}

// --- Frecency ---

function ffLoadFrecency() {
  if (ffFrecency) return Promise.resolve(ffFrecency);
  return chrome.storage.local.get({frecency: {}}).then(
    function(data) { ffFrecency = data.frecency; return ffFrecency; },
    function() { ffFrecency = {}; return ffFrecency; });   // search must still work without it
}

function ffTrackSelection(url) {
  ffLoadFrecency().then(function(frecency) {
    var now = Date.now();
    var entry = frecency[url] || {count: 0};
    entry.count++;
    entry.lastUsed = now;
    frecency[url] = entry;
    Object.keys(frecency).forEach(function(key) {
      if (now - frecency[key].lastUsed > FF_FRECENCY_KEEP_DAYS * 864e5) delete frecency[key];
    });
    return chrome.storage.local.set({frecency: frecency});
  });
}

function ffFrecencyBonus(url) {
  var entry = ffFrecency && ffFrecency[url];
  if (!entry) return 0;
  var ageHours = (Date.now() - entry.lastUsed) / 3600e3;
  return Math.log2(entry.count + 1) * 10 * Math.pow(0.5, ageHours / 72);   // half-life 72h
}

// --- Scoring ---

// Score one open tab or history item against all words. null means it does not match.
function ffCalculateScoreWords(tab, words) {
  var score = 0;
  var title = tab.title || "";
  var hostname = ffGetHostname(tab.url);

  for (var i = 0; i < words.length; i++) {
    var titleScore = ffFzfScore(title, words[i]);
    var hostScore = ffFzfScore(hostname, words[i]);
    var urlScore = ffFzfScore(tab.url, words[i]);
    if (!titleScore && !hostScore && !urlScore) return null;   // every word must match somewhere
    score += titleScore * 3 + hostScore * 2.5 + urlScore;
  }

  if (tab.visitCount) score += Math.log2(tab.visitCount + 1) * 5;

  var lastSeen = tab.lastVisitTime || tab.lastAccessed;   // history item / open tab
  if (lastSeen) score += 50 * Math.pow(0.5, (Date.now() - lastSeen) / 3600e3 / 24);   // half-life 24h

  score += ffFrecencyBonus(tab.url);
  if (tab.pinned) score += 1000;

  if (FF_DEBUGGING) {
    console.debug("match", tab.lastVisitTime ? "history" : "tab", tab.id, score.toFixed(1), hostname);
  }
  return score;
}

function ffFilter(tabs, words) {
  return tabs.map(function(tab) { tab.score = ffCalculateScoreWords(tab, words); return tab; })
             .filter(function(tab) { return tab.score !== null && tab.title; })
             .sort(function(a, b) { return b.score - a.score; });
}

// Suggestion content is "<url>#<windowId>.<tabId>" for an open tab, "<url>#url" for a history item.
function ffPrepareTab(tab, words) {
  var isHistory = !!tab.lastVisitTime;
  var content = tab.url + (isHistory ? "#url" : "#" + tab.windowId + "." + tab.id);
  var desc = ffHighlightText(tab.title, words) + " <url>" + ffHighlightText(ffGetHostname(tab.url), words) + "</url>";

  if (FF_DEBUGGING) desc = "score:" + tab.score.toFixed(1) + " - " + desc;
  if (tab.status && tab.status !== "complete") desc = "[" + tab.status + "] " + desc;
  if (tab.incognito) desc = "<url>[Incognito]</url> " + desc;
  if (tab.pinned) desc = "<url>[Pinned]</url> " + desc;
  if (tab.audible) desc = "<url>[Audible]</url> " + desc;
  if (isHistory) desc = "<url>[History]</url> " + desc;

  return {content: content, description: desc};
}

function ffConcat(tabs, histories) {
  var seen = new Set(tabs.map(function(tab) { return tab.url; }));
  return tabs.concat(histories.filter(function(item) { return !seen.has(item.url); }));
}

function ffSearchFor(text) {
  text = text.trim();
  var words = text ? text.split(/\s+/) : [];

  return Promise.all([ffLoadFrecency(), chrome.tabs.query({})]).then(function(results) {
    var tabs = ffFilter(results[1], words).slice(0, FF_MAX_SUGGESTIONS);
    if (tabs.length === FF_MAX_SUGGESTIONS) return tabs;
    var since = Date.now() - FF_HISTORY_DAYS * 864e5;
    return chrome.history.search({text: "", maxResults: 500, startTime: since}).then(function(items) {
      return ffConcat(tabs, ffFilter(items, words)).slice(0, FF_MAX_SUGGESTIONS);
    });
  }).then(function(items) {
    return items.map(function(item) { return ffPrepareTab(item, words); });
  });
}

function ffParseSelected(text) {
  var tab = text.match(/^(.*)#(\d+)\.(\d+)$/);
  if (tab) return {url: tab[1], windowId: +tab[2], tabId: +tab[3]};
  var item = text.match(/^(.*)#url$/);
  if (item) return {url: item[1]};
  return null;
}

function ffActivate(selected) {
  if (selected.tabId !== undefined) {
    chrome.tabs.update(selected.tabId, {active: true});
    chrome.windows.update(selected.windowId, {focused: true});
  } else {
    chrome.tabs.create({url: selected.url});
  }
  ffTrackSelection(selected.url);
}

chrome.omnibox.onInputChanged.addListener(function(text, suggest) {
  ffSearchFor(text).then(suggest);
});

chrome.omnibox.onInputEntered.addListener(function(text) {
  var selected = ffParseSelected(text);
  if (selected) return ffActivate(selected);
  // Enter on the default "Run ff command" row: take the top suggestion for what was typed.
  ffSearchFor(text).then(function(suggestions) {
    if (suggestions.length) ffActivate(ffParseSelected(suggestions[0].content));
  });
});
