// Minimum time the card stays dimmed, so very-fast fetches still feel like
// a beat of consideration rather than a snap.
const MIN_HOLD_MS = 260;

// Re-entrancy guard: ignore a click while a draw or reset is mid-flight.
let drawing = false;

// Whether the visible image is the card back (RoseLilyRed.jpg) or a face-up
// card. A tap on the back draws; a tap on a face-up card sets it down.
let showingBack = true;

const BACK_SRC = "RoseLilyRed.jpg";

// --- Flickr source ----------------------------------------------------
// The deck is no longer 78 fixed tarot cards but the whole of Flickr —
// each draw fetches one portrait photo sampled as randomly as the public
// API allows. Strategy: pick a random upload day between Flickr's early
// years and today, search portraits uploaded that day, jump to a random
// page within the results, pick a random photo from that page.
// Flickr "key-only" public-read methods (like flickr.photos.search) need
// only the API key. The secret is kept here for completeness / future
// signed calls but isn't sent on the wire by anything in this file.
const FLICKR_API_KEY = "bf234cae7bad1fed6373f96001293cd5";
const FLICKR_API_SECRET = "6f87a42dee30669a";
const FLICKR_REST = "https://api.flickr.com/services/rest/";
const FLICKR_EPOCH = new Date("2005-01-01").getTime();
const FLICKR_MAX_ATTEMPTS = 4;
const FLICKR_PER_PAGE = 100;
const FLICKR_RESULT_CAP = 4000; // Flickr only paginates the first 4000 hits

// Timestamp (performance.now ms) until which click events should be
// ignored. Set by the long-press handlers after a pulse/commit fires so
// the trailing click from finger-release does NOT also draw a card.
// Time-based (not flag-based) so it works regardless of whether the
// click event fires before or after touchend on a given browser.
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

// Reject any candidate that would bias the mod operation, so every card
// has exactly equal probability. With 78 outcomes and a 32-bit candidate
// the rejection rate is ~10⁻⁹ — effectively never — but doing this right
// is cheap and removes a footgun.
function unbiasedIndex(uint32, max) {
  const limit = Math.floor(0x100000000 / max) * max;
  return uint32 < limit ? uint32 % max : null;
}

// Build a closure that yields a stream of unbiased integers in [0, max),
// each one derived from a fresh SHA-256 of (cosmic ‖ gesture ‖ counter).
// One cosmic fetch per draw, reused across all the random choices the
// Flickr path needs (day, page, photo-index, plus any retry rerolls).
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

// One round trip per draw becomes two: first call learns how many photos
// were uploaded that day, second call fetches a random page from within
// the result set. Returns a Flickr static URL or null if all attempts
// failed (empty day, network error, etc.) — caller treats null as "the
// cosmos declined to answer; leave the back showing."
async function fetchRandomFlickrUrl(event) {
  const rng = await makeCosmicRng(event);
  const totalDays = Math.max(1, Math.floor((Date.now() - FLICKR_EPOCH) / 86400000));

  for (let attempt = 0; attempt < FLICKR_MAX_ATTEMPTS; attempt++) {
    const dayOffset = await rng(totalDays);
    const dayStart = FLICKR_EPOCH + dayOffset * 86400000;
    const minSec = Math.floor(dayStart / 1000);
    const maxSec = Math.floor((dayStart + 86400000) / 1000);

    const params = new URLSearchParams({
      method: "flickr.photos.search",
      api_key: FLICKR_API_KEY,
      orientation: "portrait",
      safe_search: "1",
      content_type: "1",     // photos only — no screenshots/illustrations
      media: "photos",
      min_upload_date: String(minSec),
      max_upload_date: String(maxSec),
      per_page: String(FLICKR_PER_PAGE),
      page: "1",
      format: "json",
      nojsoncallback: "1",
    });

    try {
      const head = await fetch(`${FLICKR_REST}?${params}`).then((r) => r.json());
      const total = Math.min(head?.photos?.total ?? 0, FLICKR_RESULT_CAP);
      if (total === 0) continue;
      const pages = Math.max(1, Math.ceil(total / FLICKR_PER_PAGE));
      const page = 1 + (await rng(pages));
      params.set("page", String(page));
      const body = await fetch(`${FLICKR_REST}?${params}`).then((r) => r.json());
      const photos = body?.photos?.photo ?? [];
      if (!photos.length) continue;
      const p = photos[await rng(photos.length)];
      // "_b" suffix = 1024px on the long edge: large enough for a full-
      // viewport portrait without overpaying on bandwidth.
      return `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_b.jpg`;
    } catch (_e) {
      // Try the next random day; transient network errors shouldn't strand
      // the user on a frozen back.
    }
  }
  return null;
}

async function newPage(event) {
  // If the long-press just fired a reshuffle (or aborted past the pulse
  // threshold), the trailing click should NOT draw a card. We gate on a
  // timestamp set by the long-press handlers, robust to whether `click`
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
  imgEl.classList.add("dimmed");
  const holdUntil = performance.now() + MIN_HOLD_MS;

  const chosenUrl = await fetchRandomFlickrUrl(event);
  if (!chosenUrl) {
    // Cosmos declined — release the dim and leave the back showing so
    // the next tap can try again.
    imgEl.classList.remove("dimmed");
    drawing = false;
    return;
  }
  await preloadImage(chosenUrl);

  // Honor a minimum hold so the transition has rhythm even on cache hits.
  const remaining = holdUntil - performance.now();
  if (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
  }

  // Swap the source while still dimmed (any flash is masked by low opacity),
  // then on the next frame release the dim — the card fades up into focus.
  imgEl.src = chosenUrl;
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
  await new Promise((r) => setTimeout(r, 300));

  // Now invisible — swap to the back without a visible flash.
  imgEl.src = BACK_SRC;

  // Next frame: drop the .resetting class, letting the back fade back in
  // from opacity 0 / translateY(6px) → 1 / 0 via the same transition.
  requestAnimationFrame(() => {
    imgEl.classList.remove("resetting");
    haptic(4); // a quieter beat — the card is placed
    showingBack = true;
    setTimeout(() => { drawing = false; }, 300);
  });
}

// Play the settle animation once. 520ms matches the deckSettle keyframe.
function playSettle(imgEl) {
  return new Promise((resolve) => {
    imgEl.classList.add("settling");
    setTimeout(() => {
      imgEl.classList.remove("settling");
      resolve();
    }, 520);
  });
}

// --- Long-press reshuffle ---------------------------------------------
// Critical design: the existing onclick="newPage(event)" on the <img>
// stays UNTOUCHED — it's the only thing that draws a card. The long-press
// logic below only (a) plays the charge/commit animations and (b) sets
// `suppressClicksUntil` so the trailing click from finger-release does
// not also draw.
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
const PRESS_COMMIT_MS = 2200;   // when the reshuffle commits (≈ one extra pulse)
const POST_PRESS_SUPPRESS_MS = 500; // click-suppression window after a pulse

let pulseTimer = null;
let commitTimer = null;
let pulseStarted = false;
let pressCommitted = false;

function clearPressTimers() {
  if (pulseTimer)  { clearTimeout(pulseTimer);  pulseTimer  = null; }
  if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
}

function pressStart() {
  // Idempotent: if any timer/flag is already active for this gesture,
  // a duplicate start event (e.g. pointerdown after touchstart) is a no-op.
  if (pulseTimer || commitTimer || pulseStarted || pressCommitted) return;
  if (!showingBack || drawing) return;

  const imgEl = document.querySelector("img");
  if (!imgEl) return;

  pulseTimer = setTimeout(() => {
    pulseTimer = null;
    if (!showingBack || drawing) return;
    pulseStarted = true;
    imgEl.classList.add("charging");
    // Force a style/layout flush so the animation definitely starts on
    // browsers (iOS Chrome) that otherwise sometimes batch the class
    // change with an immediately-following one.
    void imgEl.offsetHeight;
    haptic(4);

    commitTimer = setTimeout(() => {
      commitTimer = null;
      if (!showingBack || drawing) return;
      pressCommitted = true;
      imgEl.classList.remove("charging");
      haptic(12);

      // Suppress the click that may follow finger-release so the
      // reshuffle isn't chased by an unwanted draw.
      suppressClicksUntil = performance.now() + POST_PRESS_SUPPRESS_MS;

      // Commit: play the flare. With an infinite Flickr pool there's no
      // deck to reset, so the gesture is purely ceremonial — a "clear the
      // field" moment before the next draw. Use the `drawing` flag so
      // nothing else fires during the animation.
      drawing = true;
      playSettle(imgEl).then(() => {
        drawing = false;
        pulseStarted = false;
        pressCommitted = false;
      });
    }, PRESS_COMMIT_MS - PRESS_PULSE_MS);
  }, PRESS_PULSE_MS);
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

function wireLongPress() {
  const imgEl = document.querySelector("img");
  if (!imgEl) return;

  // Touch (most native on mobile WebKit, including iOS Safari).
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireLongPress);
} else {
  wireLongPress();
}
