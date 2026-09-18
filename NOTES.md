# Notes

What this app is, where it came from, and the decisions that are not
oversights. Read before touching gestures, the share pipeline, or anything
touch-related on iOS.

---

## Lineage

Forked from the single-card tarot app, `carbonsf/randomtarot` ("SC"). SC's
`NOTES.md` holds the debugging history behind every platform rule below,
and its `SPREADS.md` describes the architecture. Both are still true here.

The port (September 2026) brought over, file-for-file where it fit:

- the PWA shell: manifest, icon set (generated from the card back by
  `_gen_icons.py`), black theme, `black-translucent` status bar,
  standalone-only `overscroll-behavior: none`;
- the `?v=` cache-buster on the script tag and the `Cache-Control` meta;
- the motion vocabulary — `dimmed`, `resetting`, `chargePulse`,
  `deckSettle`, `muted` — and its two easings: `cubic-bezier(0.2,0,0,1)`
  for arrivals, `cubic-bezier(0.16,1,0.3,1)` for the contemplative reveals;
- the meanings-overlay design (Cormorant Garamond italic on a black wash,
  staggered stanza reveal, safe-area-floored padding, `touch-action: none`);
- the three-finger share: eager `File` cache, 500 ms heartbeat, watchdog,
  fire-from-`touchend`-only, single-use `File` rebuilt after every share;
- desktop reach: right-button decided on release, keys, fine-pointer gate;
- draw-without-replacement, with the settle flare at exhaustion and a
  long-press on the back to reshuffle;
- the time-based `suppressClicksUntil` rule: every gesture terminator sets
  it, because some browsers fire `click` before `touchend` and some after;
- per-photo `alt` text; deletion of the unreferenced `script.js` /
  `style.css` fossils.

Not brought over, because there is nothing for them to act on: reversals
and the glitch, the Major Arcana signatures, deck switching and the warps,
the Thoth zoom crops.

---

## Where this app deliberately differs from SC

**The deck is the word list.** SC draws from 78 cards without replacement.
Here the deck is the ~1000 nouns (`nouns.json`, Darius Kazemi's corpora),
drawn without replacement; each word becomes a Flickr *tag* query, and the
cosmic RNG picks a page and a photo inside that tag. When every word has
been drawn the next draw flares and reshuffles, exactly as SC's deck does.
Words whose tag has no portrait hits are consumed as duds.

**Hold on a face-up photo re-rolls within the word.** In SC, a hold on a
face-up card opens the meanings. Here it keeps its original meaning — a
fresh page+photo from the same tag, so the querent can linger inside one
word — and the "meanings" moved to a **two-finger tap**. Decided
2026-09-18; the reasoning was that the re-roll is the more-used verb on a
photo and had already earned the hold.

**The two-finger tap raises the word.** The overlay shows the noun that
summoned the picture, then the photograph's title, the photographer, the
licence and a link to the photo's Flickr page. It is both the app's
"meanings" screen and its attribution: Flickr's API terms ask for a
link-back whenever a photo is displayed, and this is the only place one
can live in an interface with no chrome. Desktop: quick right-click or `I`
toggles it; `Escape` dismisses.

**Entropy keeps SC's fallback chain.** NIST beacon → random.org →
`crypto.getRandomValues`. The spread app (`~/TarotSpreads`) made the
opposite call — the deck waits for the pulse, never a local fallback. That
was considered here on 2026-09-18 and the chain was kept: a beacon outage
should not block a draw whose other half (Flickr) is already a network
dependency. One cosmic fetch per draw, reused for every random choice in
that draw (word, page, photo, and any retry).

**Hosting stays static.** GitHub Pages, no build, no server. The Flickr
value in `Randomizer.js` is an API *key*, public by design for client-side
read-only calls; the API *secret* was removed from the file and scrubbed
from history and must never return. A proxy (Vercel function, Worker) was
considered on 2026-09-18 and declined — nothing here needs hiding.

**No `viewport-fit=cover`** — SC's decision, kept. With cover the layout
viewport extends under the status bar, `100dvh` becomes the whole screen,
and the centred card is pushed up under the status bar.

---

## Platform rules already paid for (from SC's NOTES.md)

- `navigator.share()` needs the `File` **synchronously**, inside the event
  handler — any `await` first throws away the transient user activation.
  Hence the eager cache; the gesture only hands over what is already there.
- **Transient activation for touch comes only from `touchend`** — never
  `touchstart`, never `touchcancel`. Anything that hosts a multi-finger
  gesture needs `touch-action: none`, or iOS hands the gesture to its own
  scroller and ends it with `touchcancel`.
- **A `File` handed to `share()` is single-use on iOS.** Rebuild after every
  share or the next one silently fails.
- **When a cache is only refreshed by events, one missed event strands it
  forever.** The share heartbeat exists because the observer → debounce →
  `drawing`-clears chain missed on the iOS PWA in ways no timing fix
  caught. Guarantee the outcome with a cheap idempotent check; don't add a
  fourth fix to the chain.
- **Don't animate CSS filters per frame** on iOS; transform + opacity
  composite for free. The overlay's `muted` blur is a one-shot transition,
  not a per-frame animation.
- The `contextmenu` event fires on a long-press in iOS WebKit, so every
  desktop right-button behaviour is gated behind
  `(hover: hover) and (pointer: fine)`.

Flickr specifics learned here:

- `live.staticflickr.com` sends `Access-Control-Allow-Origin: *`, so the
  share `File` is a plain `fetch → blob` — no canvas, no taint.
- `flickr.photos.search` can answer 200 with `stat: "fail"`; `flickrSearch`
  throws on either so the retry loop backs off instead of reading an empty
  tag. Extras used: `url_z,url_c,url_b,url_h,url_k` for size selection,
  `owner_name,license,path_alias` for attribution.

---

## Testing in the preview pane

The pane frequently reports `document.hidden === true`, which pauses
`requestAnimationFrame` (a draw never completes), clamps `setTimeout` to
~1 s, and suppresses the share heartbeat by design. Force it before
trusting any timing- or visibility-dependent result:

```js
Object.defineProperty(document, 'hidden', { get: () => false });
```

---

## Deployment

GitHub Pages, from `main`. It lags a push by ~40–80 s; check before
debugging a "fix that didn't work":

```bash
gh api repos/carbonsf/image-oracle/pages/builds/latest --jq '{status,commit}'
```

The script tag carries `?v=<date>-<n>`; **bump it on every deploy** or
installed PWAs keep running stale code. An iOS home-screen app caches far
harder than Safari — delete and re-add it to be certain.
