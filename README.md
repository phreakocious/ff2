# ff2: Fuzzy Finder for Chrome

Type `ff` in your address bar followed by your keywords to fuzzy search your tabs and history.

**Note:** To select the first match, press Enter without arrowing down to a result. With no query at all, Enter jumps to your top-ranked tab.

<p align="center"> <a href="#"><img src="screenshot.png"/></a> </p>

## Features

- **fzf-style fuzzy matching** — the same scoring as fzf: word-start and camelCase matches score higher, contiguous runs earn a bonus, gaps are penalized, and matches that are mostly gap are dropped
- **Frecency learning** — results you pick through ff are ranked higher over time; entries unused for 30 days are forgotten
- **Smart ranking** — combines match quality, how recently a tab was focused or a page visited (exponential decay), visit frequency (log-scaled), and your selection history
- **Tabs first, then history** — searches open tabs across all windows, falls back to browser history (last 90 days)
- **Pinned tab boost** — pinned tabs are always prioritized

## Usage

Let's say you have 100 tabs open, in multiple windows.
You want to find a youtube tab of a talk you were watching a few hours ago.
Instead of going through all your tabs one by one, you could just type (in your address bar):

    ff talk ytube

and you will see a list of all the tabs that match the phrase "ytube" and "talk" in any order.

Matching is fuzzy, so "ytube" will match "youtube". Matches at word starts and in contiguous runs rank higher, and every gap costs points — the same rules fzf uses.

If fewer than five open tabs match, the remaining rows come from your history.

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/blifadmmfdnmpmdpjfaeccfacfdddiei) or load unpacked from `chrome://extensions/`.

## Development

    make test    # runs test.js under node against a stub chrome API
    make ff2.zip # builds the Web Store package

## Contributing

- Fork and submit a pull request
- [Send a feature request](https://github.com/phreakocious/ff2/issues/new)
- [Report a problem](https://github.com/phreakocious/ff2/issues/new)

## License

This extension is released under the [MIT License](http://www.opensource.org/licenses/MIT).

ff2 is a fork of [siadat/chrome-ff](https://github.com/siadat/chrome-ff) by Sina Siadat.
