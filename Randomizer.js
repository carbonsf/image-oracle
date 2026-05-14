// Minimum time the card stays dimmed, so very-fast fetches still feel like
// a beat of consideration rather than a snap.
const MIN_HOLD_MS = 260;

// Re-entrancy guard: ignore a click while a draw or reset is mid-flight.
let drawing = false;

// Whether the visible image is the card back (RoseLilyRed.jpg) or a face-up
// card. A tap on the back draws; a tap on a face-up card sets it down.
let showingBack = true;

const BACK_SRC = "RoseLilyRed.jpg";

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

async function pickRandomIndex(max, event) {
  const cosmicBytes = await getCosmicBytes();
  const gestureBytes = encodeGesture(event);

  let counter = 0;
  while (true) {
    const counterByte = new Uint8Array([counter]);
    const material = concatBytes(concatBytes(cosmicBytes, gestureBytes), counterByte);
    const digest = await crypto.subtle.digest("SHA-256", material);
    const uint32 = new DataView(digest).getUint32(0, false);
    const idx = unbiasedIndex(uint32, max);
    if (idx !== null) return idx;
    counter++;
    if (counter > 16) return uint32 % max;
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

  // Ignore a click while a draw or reset is mid-flight.
  if (drawing) return;
  drawing = true;

  if (showingBack) {
    await drawCard(imgEl, event, allCards);
  } else {
    await setDownToBack(imgEl);
  }
}

// "Breath": dim + recede, fetch entropy, swap to the chosen card, fade up.
async function drawCard(imgEl, event, allCards) {
  imgEl.classList.add("dimmed");
  const holdUntil = performance.now() + MIN_HOLD_MS;

  // Mix cosmic bytes with the gesture, preload the chosen image so the
  // reveal doesn't stall on a slow JPG.
  const idx = await pickRandomIndex(allCards.length, event);
  const chosenUrl = allCards[idx];
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
