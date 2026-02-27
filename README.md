# ff2: Fuzzy Finder for Chrome

Type `ff` in your address bar followed by your keywords to fuzzy search your tabs and history.

**Note:** To select the first match, you can press Enter without pressing down or selecting any of the results.

<p align="center"> <a href="#"><img src="screenshot-1.3.png"/></a> </p>

## Features

- **fzf-style fuzzy matching** with quality-aware scoring (contiguous matches, word boundaries, camelCase awareness)
- **Frecency learning** — results you pick frequently through ff are ranked higher over time
- **Smart ranking** — combines match quality, recency (exponential decay), visit frequency (log-scaled), and your selection history
- **Tabs first, then history** — searches open tabs across all windows, falls back to browser history (last 90 days)
- **Pinned tab boost** — pinned tabs are always prioritized

## Usage

Let's say you have 100 tabs open, in multiple windows.
You want to find a youtube tab of a talk you were watching a few hours ago.
Instead of going through all your tabs one by one, you could just type (in your address bar):

    ff talk ytube

and you will see a list of all the tabs that match the phrase "ytube" and "talk" in any order.

Matching is fuzzy, so "ytube" will match "youtube". Contiguous matches rank higher than scattered ones, and matches at word boundaries are preferred — just like fzf.

If no matching open tab is found, the extension will show matching items in your history.

## Install

Install from the [Chrome Web Store](https://github.com/phreakocious/ff2) or load unpacked from `chrome://extensions/`.

## Contributing

- Fork and submit a pull request
- [Send a feature request](https://github.com/phreakocious/ff2/issues/new)
- [Report a problem](https://github.com/phreakocious/ff2/issues/new)

## License

This extension is released under the [MIT License](http://www.opensource.org/licenses/MIT).

ff2 is a fork of [siadat/chrome-ff](https://github.com/siadat/chrome-ff) by Sina Siadat.
