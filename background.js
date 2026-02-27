var FF_MAX_SUGGESTIONS = 5;
var FF_MAX_MATCHLENGTH = 1000;
var FF_DEBUGGING = false;
var FF_INCLUDE_HISTORY = true;
var FF_MOVE_TAB_TO_FIRST = false;
var FF_MOVE_TAB_TO_FIRST_TO_CURRENT_WINDOW = false;
var ffHistory = [];
var ffCurrentWindowId;
var ffTabsOnStart = [];
var ffFrecencyCache = {};

function ffEscapeRegExp(str) {
  return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

function ffActivateTag(tab) {
  if(tab.url) {
    chrome.tabs.create({url: tab.url});
  }
  if(tab.tabId) {
    chrome.tabs.update(tab.tabId, {active: true});
    if(FF_MOVE_TAB_TO_FIRST) {
      chrome.tabs.move(tab.tabId, {index: 0});
    }
  }
  if(tab.windowId) {
    chrome.windows.update(tab.windowId, {focused: true});
  }
}

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
    console.error("Invalid URL:", url);
    return "";
  }
}

function ffHighlightText(text, words) {
  words
  .map(function(word) { return ffRegexpExactHl(word); })
  .forEach(function(word) {
    if(text.match(word)) {
      text = text.replace(word, "\0$1\1")
    }
  });

  words
  .map(function(word) { return ffRegexpFuzzy(word); })
  .forEach(function(word) {
    if(text.match(word)) {
      text = text.replace(word, function(m) {
        return "\0" + m + "\1";
      });
    }
  });
  return ffEscapeHtml(text).replace(new RegExp("\0", "g"), "<match>")
                           .replace(new RegExp("\1", "g"), "</match>");
}

function ffRegexpExact(word) {
  return new RegExp(ffEscapeRegExp(word), 'i');
}

function ffRegexpExactHl(word) {
  return new RegExp("(" + ffEscapeRegExp(word) + ")", 'ig');
}

function ffRegexpFuzzy(word) {
  return new RegExp(word.split('').map(function(ch) { return ffEscapeRegExp(ch); }).join('.{0,10}?'), 'i');
}

// --- fzf-style scoring ---

var FF_BONUS_BOUNDARY = 10;
var FF_BONUS_CAMEL = 8;
var FF_BONUS_CONSECUTIVE = 4;
var FF_BONUS_START = 2;
var FF_BOUNDARY_CHARS = /[\s_\-\/\.,:;=+!@#$%^&*()[\]{}|<>~`'"]/;

function ffIsBoundary(text, i) {
  if (i === 0) return true;
  return FF_BOUNDARY_CHARS.test(text[i - 1]);
}

function ffIsCamelBoundary(text, i) {
  if (i === 0) return false;
  var prev = text.charCodeAt(i - 1);
  var curr = text.charCodeAt(i);
  // lowercase -> uppercase transition
  return (prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90);
}

// Score a single pattern against text using fzf-like heuristics.
// Returns score > 0 on match, 0 on no match.
function ffFzfScore(text, pattern) {
  if (pattern.length === 0) return 0;
  if (text.length === 0) return 0;

  var textLower = text.toLowerCase();
  var patLower = pattern.toLowerCase();

  // Quick reject: check all chars exist in order
  var t = 0, p = 0;
  while (t < textLower.length && p < patLower.length) {
    if (textLower[t] === patLower[p]) p++;
    t++;
  }
  if (p !== patLower.length) return 0;

  // Greedy forward match with scoring
  // We try two strategies and take the best:
  // 1) greedy-first: take the first occurrence of each char
  // 2) boundary-first: prefer matches at word boundaries

  var best = ffFzfScoreGreedy(textLower, patLower, text);
  var boundaryScore = ffFzfScoreBoundary(textLower, patLower, text);
  if (boundaryScore > best) best = boundaryScore;

  return best;
}

function ffFzfScoreGreedy(textLower, patLower, textOrig) {
  var score = 0;
  var consecutive = 0;
  var pi = 0;

  for (var ti = 0; ti < textLower.length && pi < patLower.length; ti++) {
    if (textLower[ti] === patLower[pi]) {
      var charScore = 1;

      // Contiguity bonus
      consecutive++;
      if (consecutive > 1) charScore += consecutive * FF_BONUS_CONSECUTIVE;

      // Word boundary bonus
      if (ffIsBoundary(textOrig, ti)) charScore += FF_BONUS_BOUNDARY;

      // camelCase boundary bonus
      if (ffIsCamelBoundary(textOrig, ti)) charScore += FF_BONUS_CAMEL;

      // Start-of-string bonus (first 4 chars)
      if (ti < 4) charScore += (4 - ti) * FF_BONUS_START;

      score += charScore;
      pi++;
    } else {
      consecutive = 0;
    }
  }

  return pi === patLower.length ? score : 0;
}

// Boundary-preferring strategy: for each pattern char, skip ahead to
// the next word-boundary match if one exists, otherwise take first match.
function ffFzfScoreBoundary(textLower, patLower, textOrig) {
  var score = 0;
  var consecutive = 0;
  var ti = 0;

  for (var pi = 0; pi < patLower.length; pi++) {
    var foundBoundary = -1;
    var foundFirst = -1;

    for (var j = ti; j < textLower.length; j++) {
      if (textLower[j] === patLower[pi]) {
        if (foundFirst === -1) foundFirst = j;
        if (ffIsBoundary(textOrig, j) || ffIsCamelBoundary(textOrig, j)) {
          foundBoundary = j;
          break;
        }
      }
    }

    var pos;
    if (foundBoundary !== -1) {
      pos = foundBoundary;
    } else if (foundFirst !== -1) {
      pos = foundFirst;
    } else {
      return 0; // no match
    }

    var charScore = 1;

    // Contiguity: check if this char is right after the previous match
    if (pi > 0 && pos === ti) {
      consecutive++;
      charScore += consecutive * FF_BONUS_CONSECUTIVE;
    } else {
      consecutive = 1;
    }

    if (ffIsBoundary(textOrig, pos)) charScore += FF_BONUS_BOUNDARY;
    if (ffIsCamelBoundary(textOrig, pos)) charScore += FF_BONUS_CAMEL;
    if (pos < 4) charScore += (4 - pos) * FF_BONUS_START;

    score += charScore;
    ti = pos + 1;
  }

  return score;
}

// --- Frecency ---

function ffTrackSelection(url) {
  chrome.storage.local.get({frecency: {}}, function(data) {
    var frecency = data.frecency;
    var entry = frecency[url] || {count: 0, lastUsed: 0};
    entry.count++;
    entry.lastUsed = Date.now();
    frecency[url] = entry;
    chrome.storage.local.set({frecency: frecency});
    ffFrecencyCache = frecency;
  });
}

function ffLoadFrecency() {
  return new Promise(function(resolve) {
    chrome.storage.local.get({frecency: {}}, function(data) {
      ffFrecencyCache = data.frecency;
      resolve(ffFrecencyCache);
    });
  });
}

function ffFrecencyBonus(url) {
  var entry = ffFrecencyCache[url];
  if (!entry) return 0;
  var ageHours = (Date.now() - entry.lastUsed) / (1000 * 60 * 60);
  // log2(count+1) * 10, decays with half-life of 72 hours
  return Math.log2(entry.count + 1) * 10 * Math.pow(0.5, ageHours / 72);
}

// --- Scoring ---

function ffCalculateScoreWords(tab, words) {
  var score = 0;
  var hostname = ffGetHostname(tab.url);
  var allFound = true;

  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    var titleScore = ffFzfScore(tab.title, word);
    var hostScore = ffFzfScore(hostname, word);
    var urlScore = ffFzfScore(tab.url, word);

    var wordScore = titleScore * 3 + hostScore * 2.5 + urlScore * 1;

    if (titleScore === 0 && hostScore === 0 && urlScore === 0) {
      allFound = false;
      break;
    }

    score += wordScore;
  }

  // All words must match somewhere
  if (!allFound) return 0;

  // Visit count bonus (log-scaled)
  if (tab.visitCount) {
    score += Math.log2(tab.visitCount + 1) * 5;
  }

  // Recency bonus (exponential decay, half-life 24 hours)
  if (tab.lastVisitTime) {
    var ageHours = (Date.now() - tab.lastVisitTime) / (1000 * 60 * 60);
    score += 50 * Math.pow(0.5, ageHours / 24);
  }

  // Frecency bonus (from user selections via ff)
  score += ffFrecencyBonus(tab.url);

  // Pinned tab boost
  if (tab.pinned) score += 1000;

  if (FF_DEBUGGING && score > 0) {
    console.debug("matching tab", tab.lastVisitTime && "History" || "Opened",
      "id:" + tab.id, "score:" + score.toFixed(1), hostname, tab);
  }

  return score;
}

function ffFilter(tabs, words) {
  return tabs.map(function(tab) { tab.score = ffCalculateScoreWords(tab, words); return tab; })
             .filter(function(tab) { return tab.score > 0 && tab.title.length > 0; })
             .sort(function(tab1, tab2) {
                if(tab1.score < tab2.score) return 1;
                if(tab1.score > tab2.score) return -1;
                return 0;
              })
             ;
}

function ffPrepareTab(tab, words) {
  var content = tab.url + "#" + tab.windowId + "." + tab.id;
  var desc = ffHighlightText(tab.title, words) + " <url>" +  ffHighlightText(ffGetHostname(tab.url), words) + "</url>";

  if(FF_DEBUGGING) {
    desc = "score:" + tab.score.toFixed(1) + " - " + desc;
  }

  if(tab.status && tab.status !== "complete") {
    desc = "[" + tab.status + "] " + desc;
  }

  if(tab.incognito) {
    desc = "<url>[Incognito]</url> " + desc;
  }

  if(tab.pinned) {
    desc = "<url>[Pinned]</url> " + desc;
  }

  if(tab.audible) {
    desc = "<url>[Audible]</url> " + desc;
  }

  if(tab.lastVisitTime) {
    content = tab.url + "#url";
    desc = "<url>[History]</url> " + desc;
  }

  return {content: content, description: desc};
}

function ffConcat(tabs1, tabs2) {
  return tabs1.concat(ffTabsWithout(tabs2, tabs1));
}

function ffTabsWithout(whiteTabs, blackTabs) {
  return whiteTabs.filter(function (whiteTab) {
    return 0 === blackTabs.filter(function (blackTab) { return blackTab.url === whiteTab.url; }).length;
  });
}

function ffReorderTabs(tabs) {
  var windows = {};

  if(ffTabsOnStart.length === 0) {
    ffTabsOnStart = tabs.map(function(tab) { return {id: tab.id, index: tab.index}; });
  }

  tabs.forEach(function(tab, i) {
    if(FF_MOVE_TAB_TO_FIRST_TO_CURRENT_WINDOW && ffCurrentWindowId) {
      chrome.tabs.move(tab.id, {index: i, windowId: ffCurrentWindowId});
    } else {
      if(!windows[tab.windowId]) { windows[tab.windowId] = []; }
      windows[tab.windowId].push(true);
      chrome.tabs.move(tab.id, {index: windows[tab.windowId].length - 1});
    }
  });
}

function ffParseSelected(text) {
  var matchTab = text.match(/#(\d+)\.(\d+)$/);

  if(matchTab) {
    return {windowId: +matchTab[1], tabId: +matchTab[2]};
  } else {
    var matchUrl = text.match(/(.*)#url$/);
    if(matchUrl) { return {url: matchUrl[1]}; }
  }
  return null;
}

function ffSearchFor(text) {
  text = text.trim();
  var words = text.split(/\s+/);

  return ffLoadFrecency().then(function() {
    return new Promise(function(resolve) {
      chrome.tabs.query({}, function(array_of_tabs) {
        var matching_tabs = ffFilter(array_of_tabs, words);

        if(FF_MOVE_TAB_TO_FIRST) {
          ffReorderTabs(matching_tabs.slice(0, 200));
        }

        matching_tabs = matching_tabs.slice(0, FF_MAX_SUGGESTIONS);
        if(FF_INCLUDE_HISTORY && matching_tabs.length < FF_MAX_SUGGESTIONS) {
          chrome.history.search({text: "", maxResults: 500, startTime: Date.now() - 90 * 24 * 3600 * 1000}, function(array_of_history_items) {
            var matching_histories = ffFilter(array_of_history_items, words);
            resolve(ffConcat(matching_tabs.slice(0, FF_MAX_SUGGESTIONS), matching_histories).map(function(tab) { return ffPrepareTab(tab, words); } ));
          });
          return;
        }
        resolve(matching_tabs.map(function(tab) { return ffPrepareTab(tab, words); }));
      });
    });
  });
}

chrome.windows.onFocusChanged.addListener(
  function(windowId) {
    ffCurrentWindowId = windowId;
  }
);

chrome.omnibox.onInputChanged.addListener(
  function(text, suggest) {
    if(FF_DEBUGGING) { console.debug("input changed:", text); }
    ffSearchFor(text).then(function(suggestions) { suggest(suggestions); });
  }
);

chrome.omnibox.onInputCancelled.addListener(
  function() {
    // revert tab order (one by one)
    ffTabsOnStart.sort(function(tab1, tab2) {
      if(tab1.index < tab2.index) return 1;
      if(tab1.index > tab2.index) return -1;
      return 0;
    }).forEach(function(tab, i) {
      chrome.tabs.move(tab.id, {index: tab.index});
    });
    ffTabsOnStart = [];
  }
);

chrome.omnibox.onInputEntered.addListener(
  function(text) {
    if(FF_DEBUGGING) {
      console.debug("entered:", text);
      console.debug("history:", ffHistory);
    }

    var selected = {};

    if(text.length === 0) {
      if(ffHistory.length >= 2) {
        selected = ffHistory[ffHistory.length - 2];
      } else {
        return;
      }
    } else {
      selected = ffParseSelected(text);
      if(!selected) {
        // User probably typed something but selected the first default option,
        // i.e., "Run ff command: query"
        ffSearchFor(text).then(function(suggestions) {
          if(suggestions.length === 0) { return; }
          var selected = ffParseSelected(suggestions[0].content);
          ffHistory.push(selected);
          // Track the URL for frecency
          var url = suggestions[0].content.replace(/#.*$/, '');
          ffTrackSelection(url);
          ffActivateTag(selected);
        });
        return;
      }
    }

    // Track the URL for frecency
    var url = text.replace(/#.*$/, '');
    ffTrackSelection(url);

    ffHistory.push(selected);
    ffActivateTag(selected);
  }
);
