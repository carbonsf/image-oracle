// Minimum time the card stays dimmed, so very-fast fetches still feel like
// a beat of consideration rather than a snap.
const MIN_HOLD_MS = 260;

let drawing = false;

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

async function fetchANUBytes() {
  const res = await fetch(ANU_URL, {
    headers: { "x-api-key": ANU_KEY },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("ANU HTTP " + res.status);
  const json = await res.json();
  if (!json.success || !Array.isArray(json.data)) {
    throw new Error("ANU returned no data");
  }
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
    return { bytes: await fetchANUBytes(), source: "ANU" };
  } catch (e1) {
    console.warn("ANU unavailable, trying random.org:", e1);
    try {
      return { bytes: await fetchRandomOrgBytes(), source: "random.org" };
    } catch (e2) {
      console.warn("random.org also unavailable, falling back to Math.random:", e2);
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes); // browser CSPRNG; better than Math.random
      return { bytes, source: "crypto.getRandomValues" };
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
      console.debug(`draw: source=${cosmic.source}, index=${idx}`);
      return idx;
    }
    counter++;
    if (counter > 16) {
      // Defensive — should never happen.
      return uint32 % max;
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

  if (drawing) return;
  drawing = true;

  const imgEl = document.querySelector("img");

  // Begin "the breath": dim + slight recede.
  imgEl.classList.add("dimmed");
  const holdUntil = performance.now() + MIN_HOLD_MS;

  // Draw the index (random.org with Math.random fallback) and preload the
  // chosen image so the reveal doesn't stall on a slow JPG.
  const randomIndex = await pickRandomIndex(allCards.length, event);
  const chosenUrl = allCards[randomIndex];
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
    // Match the CSS transition duration before allowing another draw.
    setTimeout(() => { drawing = false; }, 260);
  });
}
