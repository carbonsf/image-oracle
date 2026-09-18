// Image Oracle — one photograph on black, drawn at random from a word.
//
// Forked from the single-card tarot app (carbonsf/randomtarot, "SC" below).
// The interaction vocabulary, motion curves, PWA shell and share pipeline
// are ported from there; NOTES.md records what was kept, what deliberately
// differs, and the platform traps already paid for.

// Minimum time the card stays dimmed, so very-fast fetches still feel like
// a beat of consideration rather than a snap.
const MIN_HOLD_MS = 260;

// Length of the deckSettle keyframe in index.html. playSettle waits for
// animationend; this is the fallback for when no animation runs.
const SETTLE_MS = 720;

// Re-entrancy guard: ignore a click while a draw or reset is mid-flight.
let drawing = false;

// Whether the visible image is the card back (RoseLilyRed.jpg) or a face-up
// photograph. A tap on the back draws; a tap on a face-up photo sets it down.
let showingBack = true;

const BACK_SRC = "RoseLilyRed.jpg";

// The photograph currently face-up, or null on the back. Populated from
// the Flickr search response at draw time; it feeds the alt text, the word
// overlay (which is also the attribution), the same-word re-roll, and the
// share file's name.
//   { id, tag, noun, title, ownername, owner, pathalias, license, url, pageUrl }
let currentPhoto = null;

// --- Flickr source ----------------------------------------------------
// Each draw picks a random noun from a curated artisanal list (Darius
// Kazemi's corpora project, ~1000 nouns) and uses it as a Flickr TAG
// query. The tag (vs free-text search) means the photographer explicitly
// labeled their image with that word — far higher signal than a text
// match. Within the result set we cosmic-randomly pick a page and a
// photo. If the chosen noun has no portrait hits, we re-pick a different
// noun and try again.
//
// The key is a Flickr *API key*, which is public by design for client-side
// read-only calls (flickr.photos.search never touches the API secret, which
// is deliberately not in this file). Keep it that way.
const FLICKR_API_KEY = "bf234cae7bad1fed6373f96001293cd5";
const FLICKR_REST = "https://api.flickr.com/services/rest/";
const FLICKR_MAX_ATTEMPTS = 6; // ~1000 nouns, mostly populated; 6 picks ≈ certain hit
const FLICKR_PER_PAGE = 100;
const FLICKR_RESULT_CAP = 4000; // Flickr only paginates the first 4000 hits

// --- The word deck: draw-without-replacement ---------------------------
// SC's deck model, applied to the nouns. Each word is drawn once per
// shuffle; when every word has been used the deck reshuffles with the
// settle flare (as SC does when its 78 cards run out), and a long-press
// on the back reshuffles it on demand. Indices into the noun list.
let nounDeck = [];
let nounDeckDealt = false;   // a word has been drawn from the current deck
function freshNounDeck(n) {
  const d = new Array(n);
  for (let i = 0; i < n; i++) d[i] = i;
  return d;
}

// Lazy, memoized noun-list fetch. The file is small (~18KB) and
// browser-cached after the first hit, so we don't bother shipping it
// inline. Warmed at page load; if the fetch fails, draws fail soft (the
// back stays).
let nounsPromise = null;
function loadNouns() {
  if (!nounsPromise) {
    nounsPromise = fetch("nouns.json")
      .then((r) => r.json())
      .then((d) => (Array.isArray(d?.nouns) ? d.nouns : []))
      .catch(() => []);
  }
  return nounsPromise;
}

// Ask Flickr to return URLs for several sizes in the search response, so
// we can pick the smallest one that still covers the device's long edge —
// plus the attribution fields the word overlay shows.
// _z=640, _c=800, _b=1024, _h=1600, _k=2048 (long edge in px).
const FLICKR_EXTRAS = "url_z,url_c,url_b,url_h,url_k,owner_name,license,path_alias";

// Flickr licence ids → short names, from flickr.photos.licenses.getInfo.
const LICENSE_NAMES = {
  "0": "all rights reserved",
  "1": "CC BY-NC-SA 2.0",  "2": "CC BY-NC 2.0",     "3": "CC BY-NC-ND 2.0",
  "4": "CC BY 2.0",        "5": "CC BY-SA 2.0",     "6": "CC BY-ND 2.0",
  "7": "no known copyright restrictions",
  "8": "United States Government work",
  "9": "CC0",              "10": "public domain",
  "11": "CC BY 4.0",       "12": "CC BY-SA 4.0",    "13": "CC BY-ND 4.0",
  "14": "CC BY-NC 4.0",    "15": "CC BY-NC-SA 4.0", "16": "CC BY-NC-ND 4.0",
};

// Device-dependent target: the card's long edge in CSS px times DPR.
// Because the <img> is constrained to the back's aspect ratio (~0.578)
// and pinned inside the viewport, its long edge is essentially the
// viewport long edge (or the short edge / aspect on very wide screens).
// Computed per draw, so a rotated phone or resized window gets the right
// tier on its next draw.
function computeCardTargetPx() {
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth || 360;
  const vh = window.innerHeight || 640;
  const aspect = 825 / 1427; // must match the CSS in index.html
  const longEdgeCss = Math.min(vh, vw / aspect);
  return Math.ceil(longEdgeCss * dpr);
}

// From a photo object's extras (url_z/url_c/...), pick the smallest size
// whose long edge >= target — or the largest available if none qualify.
function pickBestSizeUrl(photo, target) {
  const candidates = [];
  for (const k of ["z", "c", "b", "h", "k"]) {
    const url = photo[`url_${k}`];
    if (!url) continue;
    const w = +photo[`width_${k}`] || 0;
    const h = +photo[`height_${k}`] || 0;
    const longEdge = Math.max(w, h);
    if (longEdge > 0) candidates.push({ url, longEdge });
  }
  if (!candidates.length) {
    // Extras missing — fall back to a constructed _b URL (always available).
    return `https://live.staticflickr.com/${photo.server}/${photo.id}_${photo.secret}_b.jpg`;
  }
  candidates.sort((a, b) => a.longEdge - b.longEdge);
  const big = candidates.find((c) => c.longEdge >= target);
  return (big || candidates[candidates.length - 1]).url;
}

// Timestamp (performance.now ms) until which click events should be
// ignored. Set by every gesture terminator (long-press, two-finger tap,
// three-finger share, overlay dismiss, right-click) so the trailing click
// from finger-release does NOT also draw a card. Time-based (not
// flag-based) so it works regardless of whether the click event fires
// before or after touchend on a given browser.
let suppressClicksUntil = 0;

// Subtle tactile beat at the moment of reveal / set-down. Feature-detected
// because navigator.vibrate is undefined on iOS Safari and many desktops;
// where present-but-no-hardware (most desktops), the call is a silent
// no-op per spec. Already inside a user-gesture handler, so policy gates
// won't block it.
function haptic(ms) {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try { navigator.vibrate(ms); } catch (_e) { /* ignore */ }
  }
}

function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve(); // don't block reveal on a load failure
    img.src = url;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Keep the <img>'s alt current: the back, or the photograph's title,
// photographer and the word it was drawn from.
function updateCardAlt(imgEl, photo) {
  if (!imgEl) return;
  if (!photo) { imgEl.alt = "Card back"; return; }
  const title = photo.title || "Untitled photograph";
  const by = photo.ownername ? " by " + photo.ownername : "";
  imgEl.alt = `${title}${by} — drawn from the word “${photo.noun}”`;
}

// --- Entropy sources ----------------------------------------------------
// The draw is composed of (a) a strong cosmic source and (b) the querent's
// gesture — when and where they reached for the card. The two are mixed
// through SHA-256 so the resulting index inherits the entropy of the
// strongest input. This is the digital analogue of cutting the deck:
// the universe offers the cards; your hand chooses the moment.

// NIST's public Randomness Beacon. Each pulse combines two independent
// commercial quantum RNGs (different physical principles, different
// vendors), is cryptographically signed by NIST, and is published every
// 60 seconds. No key, CORS-enabled, free. https://beacon.nist.gov
const NIST_BEACON_URL = "https://beacon.nist.gov/beacon/2.0/pulse/last";

function hexToBytes(hex, count) {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function fetchNISTBeacon() {
  const res = await fetch(NIST_BEACON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("NIST HTTP " + res.status);
  const json = await res.json();
  const pulse = json && json.pulse;
  if (!pulse || typeof pulse.outputValue !== "string") {
    throw new Error("NIST returned no pulse");
  }
  // outputValue is a 512-bit (128 hex-char) value — the canonical pulse
  // output, already mixed inside NIST via SHA-512 of independent quantum
  // sources. We take the first 8 bytes.
  return hexToBytes(pulse.outputValue, 8);
}

async function fetchRandomOrgBytes() {
  const url = "https://www.random.org/integers/?num=8&min=0&max=255&col=1&base=10&format=plain&rnd=new";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("random.org HTTP " + res.status);
  const nums = (await res.text()).trim().split(/\s+/).map((s) => parseInt(s, 10));
  if (nums.length !== 8 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("bad bytes from random.org");
  }
  return new Uint8Array(nums);
}

// SC's fallback chain, kept by decision: NIST → random.org → the browser's
// CSPRNG. A beacon outage never blocks a draw. (The spread app made the
// opposite call — "the deck waits" — and that is recorded in NOTES.md.)
async function getCosmicBytes() {
  try {
    return await fetchNISTBeacon();
  } catch (_e1) {
    try {
      return await fetchRandomOrgBytes();
    } catch (_e2) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      return bytes;
    }
  }
}

// Pack the gesture (when + where + the event's high-resolution timestamp)
// into bytes. Float64 of performance.now() preserves sub-millisecond bits;
// clientX/Y are screen-position entropy.
function encodeGesture(event) {
  const buf = new ArrayBuffer(8 + 8 + 4 + 4);
  const view = new DataView(buf);
  view.setFloat64(0, performance.now(), true);
  view.setFloat64(8, event && event.timeStamp != null ? event.timeStamp : 0, true);
  view.setInt32(16, event && event.clientX != null ? event.clientX : 0, true);
  view.setInt32(20, event && event.clientY != null ? event.clientY : 0, true);
  return new Uint8Array(buf);
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Reject any candidate that would bias the mod operation, so every
// outcome has exactly equal probability. With ~1000 outcomes and a 32-bit
// candidate the rejection rate is ~10⁻⁷ — effectively never — but doing
// this right is cheap and removes a footgun.
function unbiasedIndex(uint32, max) {
  const limit = Math.floor(0x100000000 / max) * max;
  return uint32 < limit ? uint32 % max : null;
}

// Build a closure that yields a stream of unbiased integers in [0, max),
// each one derived from a fresh SHA-256 of (cosmic ‖ gesture ‖ counter).
// One cosmic fetch per draw, reused across all the random choices the
// Flickr path needs (word, page, photo-index, plus any retry rerolls).
async function makeCosmicRng(event) {
  const cosmicBytes = await getCosmicBytes();
  const gestureBytes = encodeGesture(event);
  let counter = 0;
  return async function rng(max) {
    while (true) {
      const counterByte = new Uint8Array([counter++ & 0xff]);
      const material = concatBytes(concatBytes(cosmicBytes, gestureBytes), counterByte);
      const digest = await crypto.subtle.digest("SHA-256", material);
      const uint32 = new DataView(digest).getUint32(0, false);
      const idx = unbiasedIndex(uint32, max);
      if (idx !== null) return idx;
      if (counter > 128) return uint32 % max;
    }
  };
}

// --- The draw ------------------------------------------------------------

// Tag normalization: Flickr collapses tags to lowercase and strips spaces
// and most punctuation. We match that locally so a noun like "Frenchman"
// queries as "frenchman".
function normalizeTag(noun) {
  return String(noun).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// The photo's page on Flickr — the link-back the API terms ask for.
function photoPageUrl(p) {
  return `https://www.flickr.com/photos/${p.pathalias || p.owner}/${p.id}/`;
}

// One search request, with the response checked rather than trusted: a
// non-2xx (rate limit, outage) or a stat:"fail" body both throw, so the
// caller's retry loop treats them as a transient miss instead of reading
// `undefined.total` as an empty tag.
async function flickrSearch(params) {
  const res = await fetch(`${FLICKR_REST}?${params}`);
  if (!res.ok) throw new Error("Flickr HTTP " + res.status);
  const json = await res.json();
  if (!json || json.stat !== "ok") {
    throw new Error("Flickr " + ((json && json.message) || "stat != ok"));
  }
  return json;
}

// Each attempt: draw a word from the deck, ask Flickr how many portrait
// photos carry that tag, cosmic-pick a page, cosmic-pick a photo. If the
// tag has zero hits, draw another word and try again; if the request
// errors, back off a beat first — up to FLICKR_MAX_ATTEMPTS. Returns a
// photo record or null if every attempt failed; the caller treats null as
// "the cosmos declined to answer; leave the back showing."
//
// `within` (a previous photo record) pins every attempt to that photo's
// word — the long-press re-roll — and only the page/photo re-roll.
async function fetchRandomFlickrPhoto(event, { within = null } = {}) {
  const [rng, nouns] = await Promise.all([makeCosmicRng(event), loadNouns()]);
  if (!within && !nouns.length) return null;
  const target = computeCardTargetPx();

  for (let attempt = 0; attempt < FLICKR_MAX_ATTEMPTS; attempt++) {
    let noun, tag;
    if (within) {
      noun = within.noun;
      tag = within.tag;
    } else {
      // Duds (empty tags) consume words too; if they empty the deck
      // mid-draw, refill quietly — the flare is for the draw boundary.
      if (nounDeck.length === 0) nounDeck = freshNounDeck(nouns.length);
      const at = await rng(nounDeck.length);
      noun = nouns[nounDeck.splice(at, 1)[0]];
      nounDeckDealt = true;
      tag = normalizeTag(noun);
    }
    if (!tag) continue;

    const params = new URLSearchParams({
      method: "flickr.photos.search",
      api_key: FLICKR_API_KEY,
      tags: tag,
      orientation: "portrait",
      safe_search: "1",
      content_type: "1",     // photos only — no screenshots/illustrations
      media: "photos",
      per_page: String(FLICKR_PER_PAGE),
      page: "1",
      extras: FLICKR_EXTRAS,
      format: "json",
      nojsoncallback: "1",
    });

    try {
      const head = await flickrSearch(params);
      const total = Math.min(+head?.photos?.total || 0, FLICKR_RESULT_CAP);
      if (total === 0) continue; // unused tag — draw a different word
      const pages = Math.max(1, Math.ceil(total / FLICKR_PER_PAGE));
      const page = 1 + (await rng(pages));
      // First-page hits are already in `head`; only round-trip again if we
      // cosmic-picked a different page.
      let photos = head?.photos?.photo ?? [];
      if (page !== 1) {
        params.set("page", String(page));
        const body = await flickrSearch(params);
        photos = body?.photos?.photo ?? [];
      }
      if (!photos.length) continue;
      const p = photos[await rng(photos.length)];
      const photo = {
        id: String(p.id),
        tag,
        noun,
        title: String(p.title || "").trim(),
        ownername: String(p.ownername || "").trim(),
        owner: String(p.owner || ""),
        pathalias: String(p.pathalias || ""),
        license: String(p.license ?? ""),
        // Pick the smallest Flickr-hosted size whose long edge covers this
        // device's card box. Saves bandwidth on phones, avoids upscaling on
        // retina desktops. Falls back to a constructed _b URL if the photo
        // didn't come back with any size extras.
        url: pickBestSizeUrl(p, target),
      };
      photo.pageUrl = photoPageUrl(photo);
      return photo;
    } catch (_e) {
      // Transient network or rate-limit error: a short, growing pause so
      // a burst of retries doesn't compound the limit, then re-pick.
      await sleep(150 * (attempt + 1));
    }
  }
  return null;
}

async function newPage(event) {
  // If a gesture just fired (long-press, two-finger tap, share, overlay
  // dismiss), the trailing click should NOT draw a card. We gate on a
  // timestamp set by the gesture handlers, robust to whether `click`
  // fires before or after `touchend` on a given browser.
  if (performance.now() < suppressClicksUntil) return;

  const imgEl = document.querySelector("img");

  // Ignore a click while a draw or reset is mid-flight.
  if (drawing) return;
  drawing = true;

  if (showingBack) {
    await drawCard(imgEl, event);
  } else {
    await setDownToBack(imgEl);
  }
}

// "Breath": dim + recede, fetch a random Flickr portrait, swap, fade up.
async function drawCard(imgEl, event) {
  // If the word deck is exhausted — every noun drawn once — honor the
  // moment with the settle flare before dealing from a fresh shuffle
  // (SC's deck-exhaustion beat). The very first draw just deals.
  const nouns = await loadNouns();
  if (nouns.length && nounDeck.length === 0) {
    if (nounDeckDealt) await playSettle(imgEl);
    nounDeck = freshNounDeck(nouns.length);
  }

  imgEl.classList.add("dimmed");
  const holdUntil = performance.now() + MIN_HOLD_MS;

  const photo = await fetchRandomFlickrPhoto(event);
  if (!photo) {
    // Cosmos declined — release the dim and leave the back showing so
    // the next tap can try again.
    imgEl.classList.remove("dimmed");
    drawing = false;
    return;
  }
  await preloadImage(photo.url);

  // Honor a minimum hold so the transition has rhythm even on cache hits.
  const remaining = holdUntil - performance.now();
  if (remaining > 0) await sleep(remaining);

  // Swap the source while still dimmed (any flash is masked by low opacity),
  // then on the next frame release the dim — the card fades up into focus.
  imgEl.src = photo.url;
  currentPhoto = photo;
  updateCardAlt(imgEl, photo);
  requestAnimationFrame(() => {
    imgEl.classList.remove("dimmed");
    haptic(10); // a contemplative beat — the card has arrived
    showingBack = false;
    setTimeout(() => { drawing = false; }, 260);
  });
}

// "Set down": face-up card drifts down + fades out, then is replaced by
// the back, which fades in crisply. Qualitatively different from the draw
// (vertical, not depth; firmer easing; no scale).
async function setDownToBack(imgEl) {
  // Make sure the back is in cache before we start the motion, so the
  // swap is instant and the fade-in is smooth.
  await preloadImage(BACK_SRC);

  imgEl.classList.add("resetting");
  await sleep(300);

  // Now invisible — swap to the back without a visible flash.
  imgEl.src = BACK_SRC;

  // Next frame: drop the .resetting class, letting the back fade back in
  // from opacity 0 / translateY(6px) → 1 / 0 via the same transition.
  requestAnimationFrame(() => {
    imgEl.classList.remove("resetting");
    haptic(4); // a quieter beat — the card is placed
    showingBack = true;
    currentPhoto = null;
    updateCardAlt(imgEl, null);
    setTimeout(() => { drawing = false; }, 300);
  });
}

// Play the settle animation once, resolving on animationend so the flare
// is never cut short (and never overstays). The timer is the fallback for
// reduced-motion, where the keyframe is `animation: none` and no
// animationend ever arrives.
function playSettle(imgEl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      imgEl.removeEventListener("animationend", onEnd);
      imgEl.classList.remove("settling");
      resolve();
    };
    const onEnd = (e) => { if (e.animationName === "deckSettle") finish(); };
    imgEl.addEventListener("animationend", onEnd);
    imgEl.classList.add("settling");
    setTimeout(finish, reducedMotion() ? 0 : SETTLE_MS + 120);
  });
}

// --- Long-press: reshuffle the words / re-roll within the word ----------
// Critical design: the existing onclick="newPage(event)" on the <img>
// stays UNTOUCHED — it's the only thing that draws a card. The long-press
// logic below only (a) plays the charge/commit animations, (b) acts on the
// commit, and (c) sets `suppressClicksUntil` so the trailing click from
// finger-release does not also draw.
//
// On the BACK a commit reshuffles the word deck — every noun becomes
// drawable again. On a FACE-UP photo it re-rolls inside the same word: a
// fresh page+photo from the same Flickr tag, letting the querent linger
// inside one word and watch its facets shift. (SC opens its meanings
// screen here; this app puts that on a two-finger tap instead — see
// NOTES.md.)
//
// We register THREE event families: touch, pointer, AND mouse. iOS Chrome
// in particular has been observed not to deliver touchstart reliably to
// the page even when iOS Safari does — pointerdown often fires where
// touchstart doesn't. Handlers are idempotent (guarded by the existing
// timers/flags), so whichever family fires first wins and the others are
// no-ops for that gesture.
//
// We never preventDefault on the start events — the inline onclick must
// remain reachable so a quick tap always draws.

const PRESS_PULSE_MS = 600;     // when the charge-up pulse begins
const PRESS_COMMIT_MS = 2200;   // when the commit fires (≈ one extra pulse)
const POST_PRESS_SUPPRESS_MS = 500; // click-suppression window after a gesture

let pulseTimer = null;
let commitTimer = null;
let pulseStarted = false;
let pressCommitted = false;

// Fingers currently on the screen, tracked from the document-level touch
// handlers so pointer/mouse-family press events can tell a second finger
// has landed (they carry no `touches` of their own).
let touchCount = 0;

function clearPressTimers() {
  if (pulseTimer)  { clearTimeout(pulseTimer);  pulseTimer  = null; }
  if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
}

// Fully abort an in-flight long-press (used when a second finger lands,
// turning the interaction into a multi-finger gesture instead, and by the
// desktop right-button).
function cancelPress() {
  clearPressTimers();
  if (pulseStarted) {
    const imgEl = document.querySelector("img");
    if (imgEl) imgEl.classList.remove("charging");
  }
  pulseStarted = false;
  pressCommitted = false;
}

function pressStart(event) {
  // Multi-touch is reserved for the two-finger tap and three-finger share.
  // If a second finger is already down, abort any single-finger long-press
  // so the gestures don't collide.
  if (touchCount >= 2 || (event && event.touches && event.touches.length >= 2)) {
    cancelPress();
    return;
  }
  // Only the primary button charges; the secondary button has its own
  // desktop meaning (see wireDesktop).
  if (event && typeof event.button === "number" && event.button !== 0) return;
  // Idempotent: if any timer/flag is already active for this gesture,
  // a duplicate start event (e.g. pointerdown after touchstart) is a no-op.
  if (pulseTimer || commitTimer || pulseStarted || pressCommitted) return;
  if (drawing || infoOverlayOpen) return;

  const imgEl = document.querySelector("img");
  if (!imgEl) return;

  // Capture the gesture event for cosmic-entropy seeding inside the
  // commit callback (timer closures don't otherwise receive it).
  const gestureEvent = event;

  pulseTimer = setTimeout(() => {
    pulseTimer = null;
    if (drawing || infoOverlayOpen) return;
    pulseStarted = true;
    imgEl.classList.add("charging");
    // Force a style/layout flush so the animation definitely starts on
    // browsers (iOS Chrome) that otherwise sometimes batch the class
    // change with an immediately-following one.
    void imgEl.offsetHeight;
    haptic(4);

    commitTimer = setTimeout(() => {
      commitTimer = null;
      if (drawing || infoOverlayOpen) return;
      pressCommitted = true;
      imgEl.classList.remove("charging");
      haptic(12);

      // Suppress the click that may follow finger-release so the
      // commit isn't chased by an unwanted draw/set-down.
      suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;

      // Snapshot card state at commit time. On a face-up photo the
      // gesture re-rolls within the same word; on the back it reshuffles
      // the words.
      const within = (!showingBack && currentPhoto) ? currentPhoto : null;

      drawing = true;
      // Kick the fetch in parallel with the settle animation so the
      // ritual and the network round trip overlap.
      const fetchPromise = within
        ? fetchRandomFlickrPhoto(gestureEvent, { within })
        : Promise.resolve(null);

      playSettle(imgEl).then(async () => {
        if (within) {
          await applyReshuffledPhoto(imgEl, fetchPromise);
        } else {
          // Reshuffle: the next draw deals from a fresh deck of every
          // word. nounDeckDealt is cleared so that draw doesn't flare a
          // second time for "exhaustion".
          nounDeck = [];
          nounDeckDealt = false;
        }
        drawing = false;
        pulseStarted = false;
        pressCommitted = false;
      });
    }, PRESS_COMMIT_MS - PRESS_PULSE_MS);
  }, PRESS_PULSE_MS);
}

// Final beat of a face-up re-roll: after the flare, dim → swap → fade up.
// Mirrors the back-of-card drawCard rhythm so the two paths feel
// consistent, just without flipping `showingBack`.
async function applyReshuffledPhoto(imgEl, fetchPromise) {
  imgEl.classList.add("dimmed");
  const holdUntil = performance.now() + MIN_HOLD_MS;
  const photo = await fetchPromise;
  if (!photo) {
    imgEl.classList.remove("dimmed");
    return;
  }
  await preloadImage(photo.url);
  const remaining = holdUntil - performance.now();
  if (remaining > 0) await sleep(remaining);
  imgEl.src = photo.url;
  currentPhoto = photo;
  updateCardAlt(imgEl, photo);
  await new Promise((r) => requestAnimationFrame(r));
  imgEl.classList.remove("dimmed");
  haptic(10);
}

function pressEnd() {
  clearPressTimers();

  if (pressCommitted) {
    // Commit already handled the suppress window; nothing to do here.
    // (pressCommitted is cleared inside the commit's playSettle promise.)
    return;
  }

  if (pulseStarted) {
    // Released during the pulse — abort. Stop the animation and suppress
    // any imminent click so the gesture doesn't accidentally draw.
    const imgEl = document.querySelector("img");
    if (imgEl) imgEl.classList.remove("charging");
    suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;
    pulseStarted = false;
    return;
  }

  // Pulse never started (a normal tap). Do nothing — let the onclick
  // fire `newPage` and draw a card as usual.
}

// --- The word overlay -----------------------------------------------------
// Two-finger tap on a face-up photograph raises the word that summoned it,
// with the photograph's title, photographer, licence and a link back to
// its Flickr page. It is this app's "meanings" screen and its attribution
// in one. Tapping anywhere dismisses it (the link excepted); a second
// two-finger tap does too.

let infoOverlayOpen = false;

function openInfoOverlay(imgEl) {
  const overlay = document.getElementById("info-overlay");
  if (!overlay || !imgEl) return;
  if (showingBack || drawing || !currentPhoto || infoOverlayOpen) return;
  cancelPress();
  infoOverlayOpen = true;

  // Mute the photo behind the overlay so it recedes without disappearing.
  imgEl.classList.add("muted");

  renderInfoOverlay(overlay, currentPhoto);

  // Force the DOM to commit, then add .open on the next frame so the
  // staggered transitions actually animate (not just snap to final state).
  void overlay.offsetHeight;
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function renderInfoOverlay(overlay, photo) {
  // Clear and rebuild. Building from scratch each open keeps the
  // staggered-fade animation predictable (no leftover transition states).
  overlay.innerHTML = "";
  overlay.classList.remove("animating");
  // The animating flag opts every part into the cascade fade-in. Always
  // on for the live design; CSS handles prefers-reduced-motion.
  overlay.classList.add("animating");

  // Reveal cadence — tuned for a contemplative beat (SC's numbers). After
  // the two-finger tap, the photo mutes (700ms) while the scrim arrives
  // (520ms); then a brief silence, then the word settles in, and the
  // attribution follows a beat behind it.
  const INITIAL_DELAY = 360;  // ms before the stanza begins
  const HEAD_HOLD     = 220;  // ms the word gets before its line starts
  const SUB_STEP      =  55;  // ms between parts of the line

  const stage = document.createElement("div");
  stage.className = "info-stage";

  const stanza = document.createElement("div");
  stanza.className = "info-stanza";
  stanza.style.transitionDelay = INITIAL_DELAY + "ms";

  // Headline: the word, as it appears in the noun list (not the
  // flattened tag), italic.
  const head = document.createElement("div");
  head.className = "info-head";
  head.textContent = photo.noun || photo.tag;
  stanza.appendChild(head);

  // The line: title · by photographer · licence · on Flickr. Each part is
  // its own span so the cascade can stagger them.
  const parts = [];
  if (photo.title) parts.push({ text: photo.title });
  if (photo.ownername) parts.push({ text: "by " + photo.ownername });
  const lic = LICENSE_NAMES[photo.license];
  if (lic) parts.push({ text: lic });
  parts.push({ text: "on Flickr", href: photo.pageUrl });

  const flow = document.createElement("p");
  flow.className = "info-flow";
  parts.forEach((part, i) => {
    if (i > 0) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      dot.textContent = "·";
      flow.appendChild(dot);
    }
    let el;
    if (part.href) {
      el = document.createElement("a");
      el.href = part.href;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      // The link is the one tap on this screen that should NOT dismiss it.
      el.addEventListener("click", (e) => e.stopPropagation());
    } else {
      el = document.createElement("span");
    }
    el.className = "sub";
    el.textContent = part.text;
    el.style.transitionDelay = (INITIAL_DELAY + HEAD_HOLD + i * SUB_STEP) + "ms";
    flow.appendChild(el);
  });
  stanza.appendChild(flow);

  stage.appendChild(stanza);
  overlay.appendChild(stage);
}

function closeInfoOverlay() {
  if (!infoOverlayOpen) return;
  const overlay = document.getElementById("info-overlay");
  const imgEl = document.querySelector("img");
  if (overlay) overlay.classList.remove("open");
  if (imgEl) imgEl.classList.remove("muted");
  // Hold the suppress-clicks window briefly so the dismissing tap doesn't
  // also set the photo down.
  suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;
  // Defer flag reset slightly so a new press doesn't start mid-fade.
  setTimeout(() => { infoOverlayOpen = false; }, 320);
}

function toggleInfoOverlay() {
  if (infoOverlayOpen) closeInfoOverlay();
  else openInfoOverlay(document.querySelector("img"));
}

// --- Two-finger tap ----------------------------------------------------
// Classified by what a tap is NOT: two fingers that land together, barely
// move, and lift within a third of a second. A pinch or drag moves the
// midpoint and disqualifies itself; a third finger hands the gesture to
// the share. Listeners live on `document` in the capture phase (SC's
// lesson: one code path for the card and the overlay), and no-op unless
// exactly two touches are present.
const TWO_TAP_MAX_MS = 350;
const TWO_TAP_MAX_MOVE = 24;   // px of midpoint travel before it's a drag

let tfActive = false;
let tfStart = null;            // { t, x, y }

function tfMid(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function twoFingerStart(e) {
  if (!e.touches) return;
  if (e.touches.length !== 2) { if (e.touches.length > 2) tfActive = false; return; }
  cancelPress();   // a second finger turns a hold into a two-finger gesture
  const m = tfMid(e.touches);
  tfActive = true;
  tfStart = { t: performance.now(), x: m.x, y: m.y };
  // Keep Safari's own two-finger gestures (zoom-out, back-swipe) out of it.
  if (e.cancelable) e.preventDefault();
}

function twoFingerMove(e) {
  if (!tfActive || !e.touches) return;
  if (e.touches.length !== 2) { tfActive = false; return; }
  const m = tfMid(e.touches);
  if (Math.hypot(m.x - tfStart.x, m.y - tfStart.y) > TWO_TAP_MAX_MOVE) tfActive = false;
  if (e.cancelable) e.preventDefault();
}

function twoFingerEnd(e) {
  if (!tfActive) return;
  // The gesture ends when the first of the two fingers lifts.
  if (e.touches && e.touches.length >= 2) return;
  tfActive = false;
  if (e.type === "touchcancel") return;
  if (performance.now() - tfStart.t > TWO_TAP_MAX_MS) return;
  suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;
  if (infoOverlayOpen) { closeInfoOverlay(); return; }
  if (showingBack || drawing || !currentPhoto) return;
  haptic(6);
  openInfoOverlay(document.querySelector("img"));
}

// --- Three-finger swipe-up: native share of the current photograph ------
// A three-finger swipe from bottom to top while a photo is face-up hands
// the displayed image to the device's native share sheet (Web Share API).
//
// This is engineered hard for iOS Safari, where naive implementations
// fire only "sometimes" and never twice. The defenses, and the iOS quirk
// each one answers (all inherited from SC — see NOTES.md):
//
//   1. EAGER FILE CACHE. The shareable File for whatever photo is on screen
//      is built ahead of time. So at gesture time we NEVER await —
//      navigator.share() is called synchronously inside the touch handler.
//      iOS requires transient user activation for share(), and ANY await
//      before it consumes that activation.
//
//   2. FIRE ONLY FROM touchend. touchmove carries no activation, and a
//      touchcancel carries none either — share() called from it is refused
//      with NotAllowedError. On cancel we reset so the swipe can be redone.
//
//   3. shareInFlight CAN'T STICK. The iOS share promise frequently never
//      settles (cancelling the sheet, and in standalone PWAs). We reset the
//      flag at the start of every gesture, on visibilitychange, AND via a
//      watchdog timeout. It can never permanently latch.
//
//   4. A HEARTBEAT guarantees the file exists. The event chain that
//      rebuilds it (observer → debounce → `drawing` clears) missed on the
//      iOS PWA in ways no timing fix caught; a cheap idempotent check
//      every 500 ms repairs the state instead.
//
//   5. Only the image file is shared — no title/text. (Attribution lives
//      on the word overlay.)
let threeFingerActive = false;
let threeFingerStartY = 0;
let threeFingerPeakUp = 0;      // largest upward travel seen this gesture
let threeFingerArmed  = false;
let threeFingerFired  = false;  // already fired this gesture (anti-double)
let currentShareFile  = null;   // eagerly-built File for the on-screen photo
let currentShareKey   = "";     // the src currentShareFile was built from
let shareFileToken    = 0;      // guards against stale async builds
let shareInFlight     = false;  // a share sheet is (believed) open
let shareWatchdog     = null;

function shareKeyFor(imgEl) { return imgEl.src; }

function avgY(touches) {
  let s = 0;
  for (let i = 0; i < touches.length; i++) s += touches[i].clientY;
  return s / touches.length;
}

// Rebuild the cached share File for whatever photo is currently displayed.
// Debounced + token-guarded so a burst of class flips doesn't thrash, and
// a stale build can't overwrite a newer one.
let shareRefreshTimer = null;
let shareRetryTimer = null;
let shareRetries = 0;
let shareBuilding = false;      // a build is in flight — don't start another
function scheduleShareRefresh() {
  if (shareRefreshTimer) clearTimeout(shareRefreshTimer);
  shareRefreshTimer = setTimeout(refreshShareFile, 120);
  shareRetries = 0;              // a fresh trigger deserves a fresh budget
}
function refreshShareFile() {
  const imgEl = document.querySelector("img");
  const token = ++shareFileToken;

  // A draw is still mid-flight: clear the stale file (never share another
  // photo's image), but come back once the gate lifts instead of giving up.
  if (drawing) {
    currentShareFile = null; currentShareKey = "";
    if (shareRetryTimer) clearTimeout(shareRetryTimer);
    if (shareRetries++ < 30) {   // ~9s, covers a slow re-roll and then some
      shareRetryTimer = setTimeout(refreshShareFile, 300);
    }
    return;
  }
  shareRetries = 0;

  // Genuinely nothing to share: the back is up.
  if (!imgEl || showingBack || !currentPhoto) { currentShareFile = null; currentShareKey = ""; return; }
  const url = imgEl.src;
  const key = shareKeyFor(imgEl);

  shareBuilding = true;
  buildShareFile(url)
    .then((f) => { if (token === shareFileToken) { currentShareFile = f; currentShareKey = key; } })
    .catch(() => { if (token === shareFileToken) { currentShareFile = null; currentShareKey = ""; } })
    .then(() => { if (token === shareFileToken) shareBuilding = false; });
}

// The heartbeat: the trigger that cannot be missed. Exits in two
// comparisons when there is nothing to do; never runs while hidden,
// mid-draw, on the back, or while a build is in flight.
function shareHeartbeat() {
  if (document.hidden) return;
  if (showingBack || drawing || shareBuilding) return;
  const imgEl = document.querySelector("img");
  if (!imgEl || !currentPhoto) return;
  if (currentShareFile && currentShareKey === shareKeyFor(imgEl)) return;
  refreshShareFile();
}

function threeFingerStart(e) {
  if (!e.touches || e.touches.length !== 3) return;
  // Face-up photo only; the word overlay counts (it shares the photo).
  if (showingBack || drawing) return;
  cancelPress();
  tfActive = false;
  // A brand-new deliberate gesture means any previous share is done (its
  // sheet, if open, would be intercepting touches — so we'd never get
  // here). Clear a possibly-stuck flag so this share isn't blocked.
  clearShareInFlight();
  threeFingerActive = true;
  threeFingerArmed  = false;
  threeFingerFired  = false;
  threeFingerStartY = avgY(e.touches);
  threeFingerPeakUp = 0;
  // Ensure the cache matches the photo on screen (the async build then
  // has the whole swipe to finish before touchend).
  const imgEl = document.querySelector("img");
  if (!currentShareFile || (imgEl && currentShareKey !== shareKeyFor(imgEl))) {
    refreshShareFile();
  }
  if (e.cancelable) e.preventDefault();
}

function threeFingerMove(e) {
  if (!threeFingerActive || threeFingerFired) return;
  if (!e.touches || e.touches.length !== 3) return;
  if (e.cancelable) e.preventDefault();
  // Track the largest upward travel; arm once it passes a modest threshold
  // (~12% of viewport, min 80px) so a real swipe-up qualifies even if iOS
  // is about to cancel the touch.
  const up = threeFingerStartY - avgY(e.touches);
  if (up > threeFingerPeakUp) threeFingerPeakUp = up;
  if (threeFingerPeakUp >= Math.max(80, window.innerHeight * 0.12)) {
    threeFingerArmed = true;
  }
}

// Terminator for the gesture — bound to BOTH touchend and touchcancel,
// but ONLY touchend may fire the share (a touchcancel carries no transient
// user activation). On cancel we just reset so the user can re-swipe.
function threeFingerEnd(e) {
  if (!threeFingerActive) return;
  if (e && e.type === "touchcancel") {
    threeFingerActive = false;
    threeFingerArmed  = false;
    return;
  }
  // touchend: wait until fewer than three fingers remain so a brief lift
  // mid-swipe doesn't end the gesture early.
  if (e && e.touches && e.touches.length >= 3) return;
  threeFingerActive = false;
  suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;
  if (threeFingerArmed && !threeFingerFired) {
    threeFingerFired = true;
    haptic(12);
    fireShare();   // synchronous within this touchend → activation intact
  }
}

// live.staticflickr.com answers with Access-Control-Allow-Origin: *, so
// this fetch yields a real (non-opaque) Blob that can become a File.
async function buildShareFile(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("share fetch HTTP " + resp.status);
  const blob = await resp.blob();
  const type = blob.type || "image/jpeg";
  const ext  = type === "image/png" ? "png" : "jpg";
  const tag  = (currentPhoto && currentPhoto.tag) || "photo";
  const id   = (currentPhoto && currentPhoto.id) || "";
  return new File([blob], `oracle-${tag}${id ? "-" + id : ""}.${ext}`, { type });
}

function clearShareInFlight() {
  shareInFlight = false;
  if (shareWatchdog) { clearTimeout(shareWatchdog); shareWatchdog = null; }
}

// A File handed to navigator.share is SINGLE-USE on iOS: a successful
// share consumes its underlying blob, so the same File object can't be
// shared a second time (it silently fails). After every share we drop the
// spent File and immediately build a fresh one for the next swipe.
function invalidateShareFile() {
  currentShareFile = null;
  currentShareKey = "";
  refreshShareFile();
}

// Fire the native share sheet. Must be called synchronously from a touch
// terminator so iOS still sees transient activation. Shares ONLY the
// eagerly-cached image File.
function fireShare() {
  if (shareInFlight || !navigator.share) return;
  const file = currentShareFile;
  if (!file) return;
  // canShare, when present, is authoritative; when absent (older iOS),
  // attempt the file share anyway rather than refusing.
  if (navigator.canShare && !navigator.canShare({ files: [file] })) return;
  shareInFlight = true;
  // Watchdog: if the promise never settles (a real iOS bug), free the flag
  // so future shares aren't blocked.
  shareWatchdog = setTimeout(clearShareInFlight, 8000);
  let p;
  try {
    p = navigator.share({ files: [file] });
  } catch (_e) { clearShareInFlight(); invalidateShareFile(); return; } // sync throw
  // The File is now spent. Drop it and rebuild a fresh one so the very
  // next swipe can share again.
  invalidateShareFile();
  if (p && typeof p.finally === "function") {
    p.catch(() => { /* user cancelled / platform refused */ })
     .finally(clearShareInFlight);
  } else {
    clearShareInFlight();
  }
}

// --- Desktop reach: right-click and keys --------------------------------
// Mobile has three verbs on the photo — hold (re-roll), two-finger tap
// (the word), three-finger swipe (share). A mouse has one button for the
// card, so the secondary button carries the other two, decided on release:
//   quick right-click  -> the word overlay (toggle)
//   right-click HELD   -> hand the photo to the platform share sheet
// A hold never opens the overlay, a click never shares. Keys: I toggles
// the word, Escape dismisses it. Hard-gated to fine-pointer devices, so a
// long-press on iOS — which fires `contextmenu` in WebKit — can never
// reach this. Touch behaviour is unchanged.
//
// Right-button release DOES grant transient user activation in Chrome and
// Safari on macOS (verified in SC), so share() is permitted from mouseup.
const RIGHT_HOLD_MS = 500;
let rightPressAt = 0;

function isFinePointer() {
  return !!(window.matchMedia &&
            window.matchMedia("(hover: hover) and (pointer: fine)").matches);
}

// Hand the current photo to the desktop's share sheet. Called synchronously
// from the right-button mouseup so transient user activation is intact.
// Browsers without Web Share (or that refuse the call) save the image
// instead — silently doing nothing is the worst outcome.
function desktopShareCard() {
  const file = currentShareFile;
  if (!file) return;
  haptic(12);
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      const p = navigator.share({ files: [file] });
      if (p && p.catch) {
        p.catch((err) => {
          // AbortError is the user closing the sheet — respect it.
          // NotAllowedError is the browser refusing the call — save instead.
          if (err && err.name === "NotAllowedError") desktopSaveCard(file);
        });
      }
      invalidateShareFile();         // a shared File is spent; rebuild
      return;
    } catch (_e) { /* synchronous refusal — fall through to saving */ }
  }
  desktopSaveCard(file);
}

function desktopSaveCard(file) {
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (_e) { /* nothing more we can offer */ }
}

function wireDesktop() {
  if (!isFinePointer()) return;      // touch devices keep gestures only

  // The menu is always suppressed (the card and the overlay both do this
  // already); what the press MEANS is decided on release.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancelPress();                   // a right-press shouldn't leave a charge
    suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;
  }, true);

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 2) return;      // secondary button only
    rightPressAt = performance.now();
    // Build the shareable File now, during the hold, so the release can
    // call share() synchronously — awaiting inside the firing path is
    // what costs you the user activation.
    if (!showingBack && !drawing) refreshShareFile();
  }, true);

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 2 || !rightPressAt) return;
    const held = performance.now() - rightPressAt;
    rightPressAt = 0;
    suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;
    if (showingBack || drawing) return;
    if (held >= RIGHT_HOLD_MS) desktopShareCard();   // synchronous, inside this handler
    else toggleInfoOverlay();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave shortcuts alone
    switch (e.key) {
      case "Escape": if (infoOverlayOpen) closeInfoOverlay(); else return; break;
      case "i": case "I": toggleInfoOverlay(); break;
      default: return;
    }
    e.preventDefault();
  });
}

// --- Wiring --------------------------------------------------------------

function wire() {
  const imgEl = document.querySelector("img");
  if (!imgEl) return;

  loadNouns();   // warm the word list so the first draw doesn't wait on it

  // ONE global handler set for the multi-finger gestures, in the CAPTURE
  // phase on `document`. Deliberately NOT bound to the card element and NOT
  // gated on which screen is showing: the overlay executes the identical
  // code that is proven on the card — same listeners, same phase, same
  // guards — so there is no second path that can diverge. Each handler
  // no-ops unless its exact finger count is present.
  document.addEventListener("touchstart", (e) => {
    touchCount = e.touches ? e.touches.length : 0;
    twoFingerStart(e);
    threeFingerStart(e);
  }, { passive: false, capture: true });
  document.addEventListener("touchmove", (e) => {
    twoFingerMove(e);
    threeFingerMove(e);
  }, { passive: false, capture: true });
  document.addEventListener("touchend", (e) => {
    touchCount = e.touches ? e.touches.length : 0;
    twoFingerEnd(e);
    threeFingerEnd(e);
  }, { passive: false, capture: true });
  document.addEventListener("touchcancel", (e) => {
    touchCount = e.touches ? e.touches.length : 0;
    twoFingerEnd(e);
    threeFingerEnd(e);
  }, { passive: false, capture: true });

  // Keep the eager share-File cache in sync with whatever photo is on
  // screen: every draw and re-roll changes the <img> src.
  if ("MutationObserver" in window) {
    const mo = new MutationObserver(scheduleShareRefresh);
    mo.observe(imgEl, { attributes: true, attributeFilter: ["src", "class"] });
  }
  refreshShareFile();   // build for the initial state (no-op while on the back)
  // The safety net described at shareHeartbeat().
  setInterval(shareHeartbeat, 500);

  // Returning from the native share sheet fires visibilitychange/pageshow;
  // clear any in-flight flag then so a never-settling iOS share promise can
  // never block the next swipe. Also refresh the cached file.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      clearShareInFlight();
      scheduleShareRefresh();
    }
  });
  window.addEventListener("pageshow", clearShareInFlight);

  // Long-press on the card. Touch (most native on mobile WebKit, including
  // iOS Safari).
  imgEl.addEventListener("touchstart",  pressStart, { passive: true });
  imgEl.addEventListener("touchend",    pressEnd,   { passive: true });
  imgEl.addEventListener("touchcancel", pressEnd,   { passive: true });

  // Pointer (fallback for browsers/wrappers where touchstart doesn't
  // reach the page reliably — observed in iOS Chrome).
  imgEl.addEventListener("pointerdown", pressStart);
  imgEl.addEventListener("pointerup",   pressEnd);
  imgEl.addEventListener("pointercancel", pressEnd);

  // Mouse (desktop).
  imgEl.addEventListener("mousedown",  pressStart);
  imgEl.addEventListener("mouseup",    pressEnd);
  imgEl.addEventListener("mouseleave", pressEnd);

  // Belt-and-suspenders next to the CSS callout suppression.
  imgEl.addEventListener("contextmenu", (e) => e.preventDefault());

  wireDesktop();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}
