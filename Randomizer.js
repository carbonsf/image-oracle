// Minimum time the card stays dimmed, so very-fast fetches still feel like
// a beat of consideration rather than a snap.
const MIN_HOLD_MS = 260;

// ANU free tier is ~1 request per 60 seconds. After every successful ANU
// draw we disarm the card for this long; if ANU returns 429 with a
// Retry-After header, we honor that instead.
const ANU_COOLDOWN_MS = 60_000;

let drawing = false;

// performance.now() timestamp at which the next quantum draw is allowed.
// Starts at 0 so the very first click works immediately.
let nextAvailableAt = 0;
function isCoolingDown() {
  return performance.now() < nextAvailableAt;
}
function msUntilAvailable() {
  return Math.max(0, nextAvailableAt - performance.now());
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

// ANU's quantum vacuum-fluctuation RNG. Key is in plaintext JS, which is
// fine for a public tarot app — worst case the free quota burns and we
// fall back. Don't reuse this key for anything that matters.
const ANU_KEY = "FREE_qrng-key_1778780851";
const ANU_URL = "https://api.quantumnumbers.anu.edu.au?length=8&type=uint8";

function rateLimitError(retryAfterMs) {
  const err = new Error("ANU rate limited");
  err.rateLimited = true;
  err.retryAfterMs = retryAfterMs;
  return err;
}

async function fetchANUBytes() {
  const res = await fetch(ANU_URL, {
    headers: { "x-api-key": ANU_KEY },
    cache: "no-store",
  });
  // Standard HTTP rate-limit signal.
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "", 10);
    throw rateLimitError(Number.isFinite(ra) ? ra * 1000 : ANU_COOLDOWN_MS);
  }
  if (!res.ok) throw new Error("ANU HTTP " + res.status);
  const json = await res.json();
  // ANU sometimes returns 200 with {success: false, message: "..."} when
  // the quota is exhausted; treat any message mentioning rate/limit/quota
  // as a rate-limit signal too.
  if (!json.success) {
    const msg = (json.message || "").toString();
    if (/rate|limit|quota|exceed/i.test(msg)) {
      throw rateLimitError(ANU_COOLDOWN_MS);
    }
    throw new Error("ANU error: " + (msg || "unknown"));
  }
  if (!Array.isArray(json.data)) throw new Error("ANU returned no data");
  return new Uint8Array(json.data);
}

async function fetchRandomOrgBytes() {
  // 8 bytes (0–255) as a fallback strong source.
  const url = "https://www.random.org/integers/?num=8&min=0&max=255&col=1&base=10&format=plain&rnd=new";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("random.org HTTP " + res.status);
  const nums = (await res.text())
    .trim()
    .split(/\s+/)
    .map((s) => parseInt(s, 10));
  if (nums.length !== 8 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("bad bytes from random.org");
  }
  return new Uint8Array(nums);
}

async function getCosmicBytes() {
  try {
    const bytes = await fetchANUBytes();
    return { bytes, source: "ANU", cooldownMs: ANU_COOLDOWN_MS };
  } catch (e1) {
    // If ANU specifically rate-limited us, surface that so the caller can
    // honor the exact Retry-After. We still need bytes for this draw, so
    // fall back to a non-rate-limited source — but the cooldown afterward
    // matches what ANU told us.
    const rateLimited = !!e1.rateLimited;
    console.warn(
      rateLimited
        ? `ANU rate-limited (retry in ${Math.round(e1.retryAfterMs / 1000)}s), using random.org for this draw`
        : "ANU unavailable, trying random.org:",
      e1
    );
    try {
      const bytes = await fetchRandomOrgBytes();
      return {
        bytes,
        source: "random.org",
        // Only enforce cooldown when ANU explicitly told us to wait. If ANU
        // is just down (network), don't lock the user out.
        cooldownMs: rateLimited ? e1.retryAfterMs : 0,
      };
    } catch (e2) {
      console.warn("random.org also unavailable, using crypto.getRandomValues:", e2);
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes); // browser CSPRNG; better than Math.random
      return {
        bytes,
        source: "crypto.getRandomValues",
        cooldownMs: rateLimited ? e1.retryAfterMs : 0,
      };
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

async function pickRandomIndex(max, event) {
  // Mix cosmic bytes with the gesture via SHA-256. If by some astronomical
  // bad luck the first 4 bytes fall in the bias zone, re-hash with a
  // counter byte appended and try again.
  const cosmic = await getCosmicBytes();
  const gesture = encodeGesture(event);
  let counter = 0;
  while (true) {
    const counterByte = new Uint8Array([counter]);
    const material = concatBytes(concatBytes(cosmic.bytes, gesture), counterByte);
    const digest = await crypto.subtle.digest("SHA-256", material);
    const uint32 = new DataView(digest).getUint32(0, false);
    const idx = unbiasedIndex(uint32, max);
    if (idx !== null) {
      console.debug(`draw: source=${cosmic.source}, index=${idx}, cooldown=${cosmic.cooldownMs}ms`);
      return { idx, source: cosmic.source, cooldownMs: cosmic.cooldownMs };
    }
    counter++;
    if (counter > 16) {
      return { idx: uint32 % max, source: cosmic.source, cooldownMs: cosmic.cooldownMs };
    }
  }
}

async function newPage(event) {
  // 78 external card images from learntarot.com:
  const allCards = [
    "https://www.learntarot.com/bigjpgs/maj00.jpg",
    "https://www.learntarot.com/bigjpgs/maj01.jpg",
    "https://www.learntarot.com/bigjpgs/maj02.jpg",
    "https://www.learntarot.com/bigjpgs/maj03.jpg",
    "https://www.learntarot.com/bigjpgs/maj04.jpg",
    "https://www.learntarot.com/bigjpgs/maj05.jpg",
    "https://www.learntarot.com/bigjpgs/maj06.jpg",
    "https://www.learntarot.com/bigjpgs/maj07.jpg",
    "https://www.learntarot.com/bigjpgs/maj08.jpg",
    "https://www.learntarot.com/bigjpgs/maj09.jpg",
    "https://www.learntarot.com/bigjpgs/maj10.jpg",
    "https://www.learntarot.com/bigjpgs/maj11.jpg",
    "https://www.learntarot.com/bigjpgs/maj12.jpg",
    "https://www.learntarot.com/bigjpgs/maj13.jpg",
    "https://www.learntarot.com/bigjpgs/maj14.jpg",
    "https://www.learntarot.com/bigjpgs/maj15.jpg",
    "https://www.learntarot.com/bigjpgs/maj16.jpg",
    "https://www.learntarot.com/bigjpgs/maj17.jpg",
    "https://www.learntarot.com/bigjpgs/maj18.jpg",
    "https://www.learntarot.com/bigjpgs/maj19.jpg",
    "https://www.learntarot.com/bigjpgs/maj20.jpg",
    "https://www.learntarot.com/bigjpgs/maj21.jpg",
    "https://www.learntarot.com/bigjpgs/wands01.jpg",
    "https://www.learntarot.com/bigjpgs/wands02.jpg",
    "https://www.learntarot.com/bigjpgs/wands03.jpg",
    "https://www.learntarot.com/bigjpgs/wands04.jpg",
    "https://www.learntarot.com/bigjpgs/wands05.jpg",
    "https://www.learntarot.com/bigjpgs/wands06.jpg",
    "https://www.learntarot.com/bigjpgs/wands07.jpg",
    "https://www.learntarot.com/bigjpgs/wands08.jpg",
    "https://www.learntarot.com/bigjpgs/wands09.jpg",
    "https://www.learntarot.com/bigjpgs/wands10.jpg",
    "https://www.learntarot.com/bigjpgs/wands11.jpg",
    "https://www.learntarot.com/bigjpgs/wands12.jpg",
    "https://www.learntarot.com/bigjpgs/wands13.jpg",
    "https://www.learntarot.com/bigjpgs/wands14.jpg",
    "https://www.learntarot.com/bigjpgs/cups01.jpg",
    "https://www.learntarot.com/bigjpgs/cups02.jpg",
    "https://www.learntarot.com/bigjpgs/cups03.jpg",
    "https://www.learntarot.com/bigjpgs/cups04.jpg",
    "https://www.learntarot.com/bigjpgs/cups05.jpg",
    "https://www.learntarot.com/bigjpgs/cups06.jpg",
    "https://www.learntarot.com/bigjpgs/cups07.jpg",
    "https://www.learntarot.com/bigjpgs/cups08.jpg",
    "https://www.learntarot.com/bigjpgs/cups09.jpg",
    "https://www.learntarot.com/bigjpgs/cups10.jpg",
    "https://www.learntarot.com/bigjpgs/cups11.jpg",
    "https://www.learntarot.com/bigjpgs/cups12.jpg",
    "https://www.learntarot.com/bigjpgs/cups13.jpg",
    "https://www.learntarot.com/bigjpgs/cups14.jpg",
    "https://www.learntarot.com/bigjpgs/swords01.jpg",
    "https://www.learntarot.com/bigjpgs/swords02.jpg",
    "https://www.learntarot.com/bigjpgs/swords03.jpg",
    "https://www.learntarot.com/bigjpgs/swords04.jpg",
    "https://www.learntarot.com/bigjpgs/swords05.jpg",
    "https://www.learntarot.com/bigjpgs/swords06.jpg",
    "https://www.learntarot.com/bigjpgs/swords07.jpg",
    "https://www.learntarot.com/bigjpgs/swords08.jpg",
    "https://www.learntarot.com/bigjpgs/swords09.jpg",
    "https://www.learntarot.com/bigjpgs/swords10.jpg",
    "https://www.learntarot.com/bigjpgs/swords11.jpg",
    "https://www.learntarot.com/bigjpgs/swords12.jpg",
    "https://www.learntarot.com/bigjpgs/swords13.jpg",
    "https://www.learntarot.com/bigjpgs/swords14.jpg",
    "https://www.learntarot.com/bigjpgs/pents01.jpg",
    "https://www.learntarot.com/bigjpgs/pents02.jpg",
    "https://www.learntarot.com/bigjpgs/pents03.jpg",
    "https://www.learntarot.com/bigjpgs/pents04.jpg",
    "https://www.learntarot.com/bigjpgs/pents05.jpg",
    "https://www.learntarot.com/bigjpgs/pents06.jpg",
    "https://www.learntarot.com/bigjpgs/pents07.jpg",
    "https://www.learntarot.com/bigjpgs/pents08.jpg",
    "https://www.learntarot.com/bigjpgs/pents09.jpg",
    "https://www.learntarot.com/bigjpgs/pents10.jpg",
    "https://www.learntarot.com/bigjpgs/pents11.jpg",
    "https://www.learntarot.com/bigjpgs/pents12.jpg",
    "https://www.learntarot.com/bigjpgs/pents13.jpg",
    "https://www.learntarot.com/bigjpgs/pents14.jpg"
  ];

  const imgEl = document.querySelector("img");

  // If the quantum source is still cooling down, the card is "settling" —
  // it cannot yet be pulled. The slow CSS breath communicates this without
  // any UI chrome. Click is silently absorbed.
  if (drawing || isCoolingDown()) return;
  drawing = true;

  // Begin the reveal-breath: dim + slight recede.
  imgEl.classList.remove("settling"); // in case a stale class lingers
  imgEl.classList.add("dimmed");
  const holdUntil = performance.now() + MIN_HOLD_MS;

  // Mix cosmic bytes with the gesture, preload the chosen image so the
  // reveal doesn't stall on a slow JPG.
  const { idx, source, cooldownMs } = await pickRandomIndex(allCards.length, event);
  const chosenUrl = allCards[idx];
  await preloadImage(chosenUrl);

  // Honor a minimum hold so the transition has rhythm even on cache hits.
  const remaining = holdUntil - performance.now();
  if (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
  }

  // Arm the cooldown the moment the draw completes — based on what the
  // source told us (60s after a real ANU draw, exactly Retry-After after
  // a 429, zero when we silently fell back due to network problems).
  nextAvailableAt = performance.now() + (cooldownMs || 0);

  // Swap the source while still dimmed (any flash is masked by low opacity),
  // then on the next frame release the dim — the card fades up into focus.
  imgEl.src = chosenUrl;
  requestAnimationFrame(() => {
    imgEl.classList.remove("dimmed");
    setTimeout(() => {
      drawing = false;
      // If we're still in cooldown after the reveal completes, start the
      // slow settling breath. Remove it the moment we're due to be ready.
      const wait = msUntilAvailable();
      if (wait > 0) {
        imgEl.classList.add("settling");
        setTimeout(() => imgEl.classList.remove("settling"), wait);
      }
    }, 260);
  });
}
