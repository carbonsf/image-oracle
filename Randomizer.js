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

let drawCounter = 0;

// --- Debug overlay -------------------------------------------------------
// Renders the telemetry from each draw to a prominent fixed panel. Remove
// (or hide the #debug element via CSS) once we're done validating.

function cardNameFromUrl(url) {
  const m = url.match(/\/([a-z]+)(\d+)\.jpg$/i);
  if (!m) return url;
  const suit = m[1];
  const n = parseInt(m[2], 10);
  if (suit === "maj") {
    const majors = ["Fool","Magician","High Priestess","Empress","Emperor","Hierophant","Lovers","Chariot","Strength","Hermit","Wheel of Fortune","Justice","Hanged Man","Death","Temperance","Devil","Tower","Star","Moon","Sun","Judgement","World"];
    return majors[n] || `Major ${n}`;
  }
  const ranks = ["","Ace","2","3","4","5","6","7","8","9","10","Page","Knight","Queen","King"];
  const rank = ranks[n] || String(n);
  const suitNames = { wands: "Wands", cups: "Cups", swords: "Swords", pents: "Pentacles" };
  return `${rank} of ${suitNames[suit] || suit}`;
}

function fmtMs(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} ms`;
}

function renderDebugOverlay(telem) {
  let el = document.getElementById("debug");
  if (!el) {
    el = document.createElement("div");
    el.id = "debug";
    document.body.appendChild(el);
  }

  const anu = telem.anu || {};
  const ro = telem.randomOrg || {};
  const g = telem.gesture || {};

  const sourceLabel = telem.cosmicSource === "ANU"
    ? "ANU (quantum vacuum)"
    : telem.cosmicSource === "random.org"
      ? "random.org (atmospheric)"
      : "crypto.getRandomValues (local)";
  const sourceBadge = telem.cosmicSource === "ANU" ? "✓ QUANTUM" : "⚠ FALLBACK";

  const lines = [
    `DRAW #${telem.drawNumber}  ${telem.startedAt.replace("T", " ").replace(/\..*/, "")}Z`,
    ``,
    `  source        ${sourceLabel}    ${sourceBadge}`,
    ``,
    `  ANU`,
    `    attempted   ${anu.attempted ? "yes" : "no"}`,
    `    ok          ${anu.ok === undefined ? "—" : anu.ok ? "yes" : "NO"}`,
    `    httpStatus  ${anu.httpStatus ?? "—"}`,
    `    latency     ${fmtMs(anu.latencyMs)}`,
    `    rateLimited ${anu.rateLimited ? "YES (retry " + Math.round((anu.retryAfterMs || 0) / 1000) + "s)" : "no"}`,
    `    error       ${anu.error || "—"}`,
    ``,
    (ro.attempted ? [
      `  random.org (fallback)`,
      `    ok          ${ro.ok ? "yes" : "NO"}`,
      `    httpStatus  ${ro.httpStatus ?? "—"}`,
      `    latency     ${fmtMs(ro.latencyMs)}`,
      `    error       ${ro.error || "—"}`,
      ``,
    ].join("\n") : ""),
    `  gesture`,
    `    performance.now   ${g.performanceNow != null ? g.performanceNow.toFixed(3) + " ms since load" : "—"}`,
    `    event.timeStamp   ${g.eventTimeStamp != null ? g.eventTimeStamp.toFixed(3) + " ms" : "—"}`,
    `    click (x, y)      (${g.clientX ?? "—"}, ${g.clientY ?? "—"}) px`,
    `    gesture bytes     ${g.bytesHex || "—"}`,
    ``,
    `  mixing`,
    `    cosmic bytes      ${telem.cosmicBytesHex || "—"}`,
    `    sha256 head       ${telem.hashHeadHex || "—"}`,
    `    uint32            ${telem.hashUint32 != null ? telem.hashUint32 : "—"}`,
    `    rehashes          ${telem.rejectionRehashes ?? 0}`,
    ``,
    `  result`,
    `    index             ${telem.cardIndex} / 78`,
    `    card              ${telem.cardName}`,
    `    total draw time   ${fmtMs(telem.totalDrawMs)}`,
    `    next draw in      ${(telem.cooldownMs / 1000).toFixed(1)} s`,
  ];
  el.textContent = lines.filter((l) => l != null).join("\n");
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

async function fetchANUBytes(telem) {
  const t0 = performance.now();
  telem.anu = { attempted: true };
  try {
    const res = await fetch(ANU_URL, {
      headers: { "x-api-key": ANU_KEY },
      cache: "no-store",
    });
    telem.anu.httpStatus = res.status;
    if (res.status === 429) {
      const ra = parseInt(res.headers.get("Retry-After") || "", 10);
      throw rateLimitError(Number.isFinite(ra) ? ra * 1000 : ANU_COOLDOWN_MS);
    }
    if (!res.ok) throw new Error("ANU HTTP " + res.status);
    const json = await res.json();
    telem.anu.body = json;
    if (!json.success) {
      const msg = (json.message || "").toString();
      if (/rate|limit|quota|exceed/i.test(msg)) throw rateLimitError(ANU_COOLDOWN_MS);
      throw new Error("ANU error: " + (msg || "unknown"));
    }
    if (!Array.isArray(json.data)) throw new Error("ANU returned no data");
    telem.anu.ok = true;
    telem.anu.latencyMs = performance.now() - t0;
    return new Uint8Array(json.data);
  } catch (e) {
    telem.anu.ok = false;
    telem.anu.latencyMs = performance.now() - t0;
    telem.anu.error = e.message;
    telem.anu.rateLimited = !!e.rateLimited;
    if (e.rateLimited) telem.anu.retryAfterMs = e.retryAfterMs;
    throw e;
  }
}

async function fetchRandomOrgBytes(telem) {
  const t0 = performance.now();
  telem.randomOrg = { attempted: true };
  try {
    const url = "https://www.random.org/integers/?num=8&min=0&max=255&col=1&base=10&format=plain&rnd=new";
    const res = await fetch(url, { cache: "no-store" });
    telem.randomOrg.httpStatus = res.status;
    if (!res.ok) throw new Error("random.org HTTP " + res.status);
    const nums = (await res.text()).trim().split(/\s+/).map((s) => parseInt(s, 10));
    if (nums.length !== 8 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error("bad bytes from random.org");
    }
    telem.randomOrg.ok = true;
    telem.randomOrg.latencyMs = performance.now() - t0;
    return new Uint8Array(nums);
  } catch (e) {
    telem.randomOrg.ok = false;
    telem.randomOrg.latencyMs = performance.now() - t0;
    telem.randomOrg.error = e.message;
    throw e;
  }
}

async function getCosmicBytes(telem) {
  try {
    const bytes = await fetchANUBytes(telem);
    return { bytes, source: "ANU", cooldownMs: ANU_COOLDOWN_MS };
  } catch (e1) {
    const rateLimited = !!e1.rateLimited;
    try {
      const bytes = await fetchRandomOrgBytes(telem);
      return {
        bytes,
        source: "random.org",
        cooldownMs: rateLimited ? e1.retryAfterMs : 0,
      };
    } catch (e2) {
      telem.cryptoFallback = true;
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
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

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

async function pickRandomIndex(max, event, telem) {
  const cosmic = await getCosmicBytes(telem);
  telem.cosmicSource = cosmic.source;
  telem.cosmicBytesHex = bytesToHex(cosmic.bytes);

  const gestureBytes = encodeGesture(event);
  telem.gesture = {
    performanceNow: performance.now(),
    eventTimeStamp: event && event.timeStamp != null ? event.timeStamp : null,
    clientX: event && event.clientX != null ? event.clientX : null,
    clientY: event && event.clientY != null ? event.clientY : null,
    bytesHex: bytesToHex(gestureBytes),
  };

  let counter = 0;
  while (true) {
    const counterByte = new Uint8Array([counter]);
    const material = concatBytes(concatBytes(cosmic.bytes, gestureBytes), counterByte);
    const digest = await crypto.subtle.digest("SHA-256", material);
    const uint32 = new DataView(digest).getUint32(0, false);
    telem.hashHeadHex = bytesToHex(new Uint8Array(digest).slice(0, 4));
    telem.hashUint32 = uint32;
    const idx = unbiasedIndex(uint32, max);
    if (idx !== null) {
      telem.rejectionRehashes = counter;
      return { idx, source: cosmic.source, cooldownMs: cosmic.cooldownMs };
    }
    counter++;
    if (counter > 16) {
      telem.rejectionRehashes = counter;
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
  drawCounter++;
  const drawStart = performance.now();
  const telem = { drawNumber: drawCounter, startedAt: new Date().toISOString() };
  const { idx, source, cooldownMs } = await pickRandomIndex(allCards.length, event, telem);
  const chosenUrl = allCards[idx];
  telem.cardIndex = idx;
  telem.cardName = cardNameFromUrl(chosenUrl);
  telem.cooldownMs = cooldownMs;
  telem.totalDrawMs = performance.now() - drawStart;
  renderDebugOverlay(telem);
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
