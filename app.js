
// -------- api urls --------
const API_URL = (q) =>
  "https://colormagic.app/api/palette/search?q=" + encodeURIComponent(q);

const PROXY_URL = (url) =>
  "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(url);


// -------- grab elements --------
const $ = (sel) => document.querySelector(sel);

const form        = $("#form");
const cityInput   = $("#city");
const statusEl    = $("#status");
const stageEl     = $("#stage");
const chipsEl     = $("#chips");
const stripEl     = $("#strip");
const paletteName = $("#palText");
const paletteTags = $("#palTags");
const cityLabel   = $("#cityLabel");
const pin         = $("#pin");
const pinHex      = $("#pinHex");

// svg layer groups
const linesLayer    = $("#lines");
const frontsLayer   = $("#fronts");
const stationsLayer = $("#stations");
const ridersLayer   = $("#riders");
const defsEl        = $("#mapdefs");

// sticky bar bits
const stickyBar      = $("#stickyBar");
const stickyName     = $("#stickyName");
const stickySwatches = $("#stickySwatches");
const ctrlVib        = $("#ctrlVib");
const ctrlHue        = $("#ctrlHue");
const ctrlSat        = $("#ctrlSat");
const ctrlReset      = $("#ctrlReset");

// remember the original colors so the refresh button works
let baseColors = [];      // straight from the api 
let displayColors = [];   // what's currently shown after slider tweaks

// remember which palette ids have been shown for each city so we
// can rotate through different ones instead of repeating the same.
const shownPalettes = {};   // { tokyo: Set("id1","id2",...) }


// -------- my subway routes --------
// viewBox 1600 x 1000.
//  45° diagonal. 
const ROUTES = [
  // horizontal → 45° down-right
  [[-100, 220], [500, 220], [800, 520], [1300, 520], [1720, 520]],

  // big diagonal across the middle
  [[-100, -100], [200, 200], [600, 200], [900, 500], [1300, 500], [1720, 920]],

  // upper line, drops once
  [[-100, 120], [700, 120], [900, 320], [1720, 320]],

  // vertical spine on the left, bends right at the bottom
  [[400, -100], [400, 600], [700, 900], [1720, 900]],

  // vertical spine on the right, bends left
  [[1200, -100], [1200, 400], [900, 700], [-100, 700]],

  // diagonal from bottom-left up to the right side
  [[-100, 1100], [300, 700], [700, 700], [1000, 400], [1720, 400]],

  // lower line with a little notch in the middle
  [[-100, 820], [500, 820], [700, 620], [1100, 620], [1300, 820], [1720, 820]],
];


// turn a city name into a number i can seed a random generator with
function seedFromCity(city){
  let s = 0;
  for (let i = 0; i < city.length; i++){
    s = (s * 31 + city.charCodeAt(i)) >>> 0;
  }
  return s || 1;
}

// tiny seeded random — same seed always gives the same numbers
function makeRandom(seed){
  let state = seed >>> 0;
  return function(){
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// shuffle array using a seeded random (so same city = same map)
function shuffleSeeded(arr, rand){
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--){
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// nudge each route's points around a little bit. keeps the same
// still 45° 
function jitterRoutes(routes, rand){
  return routes.map((points) => {
    // shift the whole route by a random amount
    const dx = (rand() - 0.5) * 240;
    const dy = (rand() - 0.5) * 200;
    return points.map(([x, y]) => [x + dx, y + dy]);
  });
}

// clicking a chip fills the input and submits the form
chipsEl.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  cityInput.value = chip.dataset.c;
  form.requestSubmit();
});

// handle form submit → load a city
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const city = cityInput.value.trim();
  if (city) loadCity(city);
});

// the tiny search form that lives inside the sticky bar
const form2 = $("#form2");
const city2 = $("#city2");
if (form2){
  form2.addEventListener("submit", (event) => {
    event.preventDefault();
    const c = city2.value.trim();
    if (c){
      cityInput.value = c;     // keep both inputs in sync
      loadCity(c);
      city2.value = "";
    }
  });
}


// 

async function fetchPalettes(city) {
  const url = API_URL(city);

  // try the direct request first, just in case CORS magically works
  try {
    const response = await fetch(url, { mode: "cors" });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    // ignore and fall through to the proxy
  }

  // fall back to the proxy
  const response = await fetch(PROXY_URL(url));
  if (!response.ok) throw new Error("proxy failed: " + response.status);
  return await response.json();
}


// the main function that runs when you submit a city
async function loadCity(city) {
  if (!city || city.trim().length === 0) {
    showStatus("please enter a city name");
    return;
  }

  showStatus("looking for " + escapeHtml(city) + "…", true);

  try {
    const palettes = await fetchPalettes(city);

    if (!palettes || palettes.length === 0) {
      showStatus('no palettes found for "' + escapeHtml(city) + '". try another city.');
      return;
    }

    // pick the palette that mentions the city most. score by
    // city-tag match + likes (no randomness yet — we want a stable
    // ranking so we can step through them).
    const lowerCity = city.toLowerCase();
    const ranked = palettes.map((p) => {
      let score = 0;
      if ((p.tags || []).some((t) => t.toLowerCase().includes(lowerCity))) score += 3;
      if ((p.text || "").toLowerCase().includes(lowerCity)) score += 5;
      score += (p.likesCount || 0) * 0.05;
      return { palette: p, score: score };
    });
    ranked.sort((a, b) => b.score - a.score);

    // take the top batch (up to 8) so we have a pool of good ones
    const topPool = ranked.slice(0, Math.min(8, ranked.length));

    // remember which ones we've already shown for this city.
    // when we run out of new ones, reset and start fresh.
    if (!shownPalettes[lowerCity]) shownPalettes[lowerCity] = new Set();
    let seen = shownPalettes[lowerCity];

    let unseen = topPool.filter((r) => !seen.has(r.palette.id));
    if (unseen.length === 0){
      // we've cycled through all of them — start over
      seen.clear();
      unseen = topPool;
    }

    // pick a random one from the unseen pool so variety isn't just
    // "next in line" — feels fresh each search
    const pick = unseen[Math.floor(Math.random() * unseen.length)].palette;
    seen.add(pick.id);

    paint(city, pick);
    showStatus("");

  } catch (err) {
    console.error(err);
    showStatus("couldn't reach the color service. please try again.");
  }
}


function showStatus(message, loading = false) {
  if (!message) {
    statusEl.innerHTML = "";
    return;
  }
  const cls = loading ? "loading" : "";
  statusEl.innerHTML = '<span class="' + cls + '">' + escapeHtml(message) + "</span>";
}


// 

// the active routes for the current city (re-randomized per city)
let activeRoutes = ROUTES;

function paint(city, palette) {
  // grab up to 7 colors from the palette (pad if fewer)
  let colors = (palette.colors || []).slice(0, 7);
  if (colors.length === 0) colors = ["#000000"];

  // many palettes are muted → give them a little vibrancy
  const vibrant = colors.map((c) => boostColor(c, 0.22));

  // make sure we have enough colors to fill every route
  while (vibrant.length < ROUTES.length) {
    vibrant.push(vibrant[vibrant.length % colors.length]);
  }

  // remember these so the slider refresh button can put them back
  baseColors = vibrant.slice();
  displayColors = vibrant.slice();

  // store the first 5
  const root = document.documentElement;
  vibrant.slice(0, 5).forEach((c, i) => {
    root.style.setProperty("--c" + (i + 1), c);
  });

  // city name in the corner of the map
  cityLabel.textContent = city.toLowerCase();

  // randomize the subway layout based on the city name. same city
  // always gives the same map (so it doesnt feel chaotic).
  const seed = seedFromCity(city.toLowerCase());
  const rand = makeRandom(seed);
  const shuffled = shuffleSeeded(ROUTES, rand);
  activeRoutes = jitterRoutes(shuffled, rand);

  // build the moving subway-style map
  drawMap(vibrant);

  // show the palette name + tags + swatches (the original lower section)
  paletteName.textContent = palette.text || "untitled";
  paletteTags.textContent = (palette.tags || []).slice(0, 6).join(" · ");

  stripEl.innerHTML = "";
  colors.forEach((hex) => {
    const swatch = document.createElement("div");
    swatch.className = "swatch";
    swatch.style.background = hex;
    swatch.innerHTML = '<span class="swatch__hex">' + hex.toUpperCase() + "</span>";
    swatch.addEventListener("click", () => copyToClipboard(hex));
    stripEl.appendChild(swatch);
  });

  stageEl.hidden = false;

  // populate the sticky top bar — use the city name the user typed,
  // not the made-up palette name from the api
  fillStickyBar(city, displayColors);

  // reset the sliders back to neutral when a new city loads
  ctrlVib.value = 0;
  ctrlHue.value = 0;
  ctrlSat.value = 0;
}


// ======================================================
// sticky top bar — name + clickable color blocks
// ======================================================
function fillStickyBar(name, colors){
  stickyName.textContent = name.toLowerCase();
  stickySwatches.innerHTML = "";

  colors.forEach((hex) => {
    const sw = document.createElement("div");
    sw.className = "stickybar__sw";
    sw.style.background = hex;
    sw.dataset.hex = hex;

    // hex label inside the swatch (hidden on hover so the + shows)
    const label = document.createElement("span");
    label.className = "sw-hex";
    label.textContent = hex.toUpperCase();
    sw.appendChild(label);

    sw.addEventListener("click", () => {
      // read from dataset so it works after slider changes too
      const currentHex = sw.dataset.hex || hex;
      copyToClipboard(currentHex);
      // tiny "copied" flash
      sw.classList.add("copied");
      setTimeout(() => sw.classList.remove("copied"), 600);
    });

    stickySwatches.appendChild(sw);
  });

  stickyBar.hidden = false;
  document.body.classList.add("has-sticky");
  document.body.classList.add("searched");  // hides concept/foot/etc
}


// when a new palette is loaded
let animation = null;
let paused = false;   // click anywhere on the subway to freeze it

function drawMap(colors) {
  // wipe whatever was there before
  linesLayer.innerHTML    = "";
  frontsLayer.innerHTML   = "";
  stationsLayer.innerHTML = "";
  ridersLayer.innerHTML   = "";
  defsEl.innerHTML        = "";

  // small perpendicular offsets so nearby routes read as parallel "bundles"
  const OFFSETS = [0, 26, -26, 52, -52, 78, -78];

  const lines = []; // i'll stash each line's animation info here

  activeRoutes.forEach((points, i) => {
    const color     = colors[i % colors.length];
    const nextColor = colors[(i + 1) % colors.length];
    const prevColor = colors[(i - 1 + colors.length) % colors.length];

    // shift the whole route sideways so parallel lines don't overlap
    const shifted = offsetRoute(points, OFFSETS[i] || 0);

    // build a linear gradient so the color fades into the neighbors
    const gradient = makeGradient("g_" + i, shifted, prevColor, color, nextColor);
    defsEl.appendChild(gradient.el);

    // the line itself  straight segments with sharp corners
    const dAttr = polyPath(shifted);
    const path = svg("path", {
      d: dAttr,
      stroke: "url(#g_" + i + ")",
      class: "line",
    });
    path.dataset.hex = color;
    path.addEventListener("click", (event) => showPin(event, color));
    linesLayer.appendChild(path);

    // the "front" — a short thicker chunk that slides along the line
    const totalLength = path.getTotalLength();
    const chunkLength = 180;
    const front = svg("path", {
      d: dAttr,
      stroke: color,
      class: "front",
      "stroke-dasharray": chunkLength + " " + (totalLength + chunkLength),
      "stroke-dashoffset": 0,
    });
    frontsLayer.appendChild(front);

    // the rider — a solid color circle that rides the front of the line
    const rider = svg("circle", {
      r: 16,
      class: "rider",
      fill: color,
    });
    rider.dataset.hex = color;
    rider.addEventListener("click", (event) => showPin(event, color));
    ridersLayer.appendChild(rider);

    lines.push({
      path: path,
      front: front,
      rider: rider,
      totalLength: totalLength,
      chunkLength: chunkLength,
      riderSpeed: 60 + Math.random() * 90,   // pixels per second
      frontOffset: Math.random() * totalLength,
      gradientStops: gradient.stops,
      stopDefs: gradient.stopDefs,
      phase: Math.random() * Math.PI * 2,
      flowSpeed: 0.12 + Math.random() * 0.18,
      shifted: shifted,
    });
  });

  // (stations at crossings removed — only the rider circles at the head
  //  of each line are shown now)

  // restart the animation
  if (animation && animation.rafId) cancelAnimationFrame(animation.rafId);
  animation = { lines: lines, startTime: performance.now(), lastTime: performance.now() };
  tick();
}


// helper: make a fresh <linearGradient> with 5 stops
function makeGradient(id, points, prevColor, color, nextColor) {
  const start = points[0];
  const end   = points[points.length - 1];

  const el = svg("linearGradient", {
    id: id,
    gradientUnits: "userSpaceOnUse",
    x1: start[0], y1: start[1],
    x2: end[0],   y2: end[1],
  });

  const stopDefs = [
    { offset: 0.00, color: prevColor },
    { offset: 0.25, color: color },
    { offset: 0.55, color: nextColor },
    { offset: 0.80, color: color },
    { offset: 1.00, color: prevColor },
  ];

  const stops = stopDefs.map((def) => {
    const stop = svg("stop", {
      offset: def.offset,
      "stop-color": def.color,
    });
    el.appendChild(stop);
    return stop;
  });

  return { el: el, stops: stops, stopDefs: stopDefs };
}


// ======================================================
// animation loop
// ======================================================

function tick() {
  if (!animation) return;

  const now = performance.now();
  const deltaSeconds = (now - animation.lastTime) / 1000;
  const elapsed      = (now - animation.startTime) / 1000;
  animation.lastTime = now;

  // if the user clicked the map, freeze everything in place
  if (paused){
    animation.rafId = requestAnimationFrame(tick);
    return;
  }

  animation.lines.forEach((line) => {
    // (1) slide each gradient stop a little to make the color flow
    const shift = ((elapsed * line.flowSpeed) + line.phase) % 1;
    line.gradientStops.forEach((stop, i) => {
      const newOffset = (line.stopDefs[i].offset + shift) % 1;
      stop.setAttribute("offset", newOffset.toFixed(4));
    });

    // stops have to be in ascending order — sort them in place each frame
    const parent = line.gradientStops[0].parentNode;
    const sorted = Array.from(parent.children).sort(
      (a, b) => parseFloat(a.getAttribute("offset")) - parseFloat(b.getAttribute("offset"))
    );
    sorted.forEach((node) => parent.appendChild(node));

    // (2) move the "front" chunk forward along the path
    line.frontOffset = (line.frontOffset + line.riderSpeed * deltaSeconds) % line.totalLength;
    line.front.setAttribute("stroke-dashoffset", (-line.frontOffset).toFixed(2));

    // (3) place the rider circle at the head of the front chunk
    const headPosition = (line.frontOffset + line.chunkLength) % line.totalLength;
    const point = line.path.getPointAtLength(headPosition);
    line.rider.setAttribute("cx", point.x);
    line.rider.setAttribute("cy", point.y);
  });

  animation.rafId = requestAnimationFrame(tick);
}


// ======================================================
// stations (circles at line crossings)
// ======================================================

function placeStationsAtCrossings(routes, colors) {
  const W = 1600, H = 1000;

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const routeA = routes[i];
      const routeB = routes[j];

      for (let a = 0; a < routeA.length - 1; a++) {
        for (let b = 0; b < routeB.length - 1; b++) {
          const point = segmentsCross(routeA[a], routeA[a + 1], routeB[b], routeB[b + 1]);
          if (point && point[0] > 20 && point[0] < W - 20 && point[1] > 20 && point[1] < H - 20) {
            addStation(point, colors[i % colors.length]);
          }
        }
      }
    }
  }
}


function addStation([x, y], color) {
  const circle = svg("circle", {
    cx: x, cy: y, r: 14,
    class: "station",
  });
  circle.dataset.hex = color;
  circle.addEventListener("click", (event) => showPin(event, color));
  stationsLayer.appendChild(circle);
}


// does segment (p1→p2) cross segment (p3→p4)?  returns the point or null.
function segmentsCross(p1, p2, p3, p4) {
  const [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = p3, [x4, y4] = p4;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-6) return null; // lines are parallel

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }
  return null;
}


// ======================================================
// path helpers
// ======================================================

// build a straight polyline path string: "M x y L x y L x y …"
function polyPath(points) {
  if (points.length < 2) return "";
  let d = "M " + points[0][0] + " " + points[0][1];
  for (let i = 1; i < points.length; i++) {
    d += " L " + points[i][0] + " " + points[i][1];
  }
  return d;
}


// shift a polyline perpendicular to each segment, then reconnect the corners.
// this is how i get parallel "bundled" subway lines.
function offsetRoute(points, distance) {
  if (!distance) return points.map((p) => p.slice());

  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    // perpendicular direction, normalized
    const nx = dy / length;
    const ny = -dx / length;
    segments.push([
      [x1 + nx * distance, y1 + ny * distance],
      [x2 + nx * distance, y2 + ny * distance],
    ]);
  }

  // reconnect corners by intersecting neighboring segments
  const result = [segments[0][0]];
  for (let i = 0; i < segments.length - 1; i++) {
    const corner = lineIntersect(
      segments[i][0], segments[i][1],
      segments[i + 1][0], segments[i + 1][1]
    );
    result.push(corner || segments[i][1]);
  }
  result.push(segments[segments.length - 1][1]);
  return result;
}


// where do two infinite lines cross?  returns the point or null if parallel.
function lineIntersect(p1, p2, p3, p4) {
  const [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = p3, [x4, y4] = p4;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

// pin tooltip + clipboard

// when you click a line/rider/station:
//   - freeze the animation so you can actually see what you clicked
//   - pop up a tiny hex label at the click position
//   - copy the hex to clipboard
function showPin(event, hex) {
  const svgEl = $("#map");
  const pt = svgEl.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;

  // convert screen pixel → SVG coordinates
  const loc = pt.matrixTransform(svgEl.getScreenCTM().inverse());

  pin.setAttribute("transform", "translate(" + loc.x + "," + loc.y + ")");
  pinHex.textContent = hex.toUpperCase();
  pin.style.opacity = 1;

  // freeze the subway in place — pin stays visible
  paused = true;

  // highlight all riders so you can see them stopped
  document.querySelectorAll(".rider").forEach((r) => r.classList.add("paused"));

  clearTimeout(showPin.timer);

  copyToClipboard(hex);
}

// click anywhere else on the map to unpause + hide the pin
function unpauseMap(){
  paused = false;
  pin.style.opacity = 0;
  document.querySelectorAll(".rider").forEach((r) => r.classList.remove("paused"));
}


async function copyToClipboard(hex) {
  try {
    await navigator.clipboard.writeText(hex);
  } catch (err) {
    // clipboard sometimes fails (permissions, etc) — ignore silently
  }
}


// ======================================================
// color helpers
// ======================================================

function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  h = h.padEnd(6, "0").slice(0, 6);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]) {
  const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;

  if (max === min) {
    h = 0;
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];

  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, h + 1/3);
  const g = hue2rgb(p, q, h);
  const b = hue2rgb(p, q, h - 1/3);
  return [r * 255, g * 255, b * 255];
}

// bump saturation + pull super-dark/super-light colors toward mid so they
// still read on screen
function boostColor(hex, amount) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const newS = Math.min(1, s + amount);

  let newL = l;
  if (l < 0.25) newL = 0.25 + (l / 0.25) * 0.1;
  if (l > 0.85) newL = 0.85 - ((l - 0.85) / 0.15) * 0.1;

  return rgbToHex(hslToRgb([h, newS, newL]));
}


// ======================================================
// tiny SVG element helper — makes svg() calls cleaner above
// ======================================================

function svg(tag, attrs) {
  const NS = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(NS, tag);
  for (const key in attrs) {
    if (key === "class") el.setAttribute("class", attrs[key]);
    else el.setAttribute(key, attrs[key]);
  }
  return el;
}


// ======================================================
// drag to pan the whole map sideways
// ======================================================

(function setupPan() {
  const svgEl = $("#map");
  const world = $("#world");
  if (!svgEl || !world) return;

  let panX = 0;
  let dragging = false;
  let startX = 0;
  let startPan = 0;
  let movedFar = false;   // track if it was a real drag or just a click

  // 1 screen pixel = how many svg user-units?
  function screenPxToSvgX(deltaPx) {
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return deltaPx;
    return deltaPx / ctm.a;
  }

  svgEl.style.cursor = "grab";

  svgEl.addEventListener("pointerdown", (event) => {
    // if they clicked a line/rider/station, let that click handler run instead
    if (event.target.closest(".line, .rider, .station")) return;

    dragging = true;
    movedFar = false;
    startX   = event.clientX;
    startPan = panX;
    svgEl.setPointerCapture(event.pointerId);
    svgEl.style.cursor = "grabbing";
  });

  svgEl.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = screenPxToSvgX(event.clientX - startX);
    if (Math.abs(event.clientX - startX) > 4) movedFar = true;
    panX = startPan + dx;
    world.setAttribute("transform", "translate(" + panX + ", 0)");
  });

  const stopDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    if (svgEl.releasePointerCapture) svgEl.releasePointerCapture(event.pointerId);
    svgEl.style.cursor = "grab";

    // if they didn't actually drag, treat it as a click on empty space.
    // empty-space click on a paused map = unpause.
    if (!movedFar && paused){
      unpauseMap();
    }
  };

  svgEl.addEventListener("pointerup", stopDrag);
  svgEl.addEventListener("pointercancel", stopDrag);
  svgEl.addEventListener("pointerleave", stopDrag);
})();


// ======================================================
// escape HTML so user input can't break the status line
// ======================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}


// ======================================================
// vibrancy / hue / saturation sliders + refresh button
// ======================================================

// take the original colors and apply the slider tweaks
function applyControls(){
  if (baseColors.length === 0) return;

  const vib = parseFloat(ctrlVib.value) / 100;   // -1 .. 1
  const hue = parseFloat(ctrlHue.value) / 360;   // -0.5 .. 0.5
  const sat = parseFloat(ctrlSat.value) / 100;   // -1 .. 1

  displayColors = baseColors.map((hex) => {
    let [h, s, l] = rgbToHsl(hexToRgb(hex));

    // hue rotates around
    h = (h + hue + 1) % 1;

    // saturation slider just adds/subtracts
    s = Math.max(0, Math.min(1, s + sat));

    // vibrancy = saturation up + push lightness toward middle a bit
    if (vib > 0){
      s = Math.min(1, s + vib * 0.5);
      l = l + (0.5 - l) * vib * 0.3;
    } else if (vib < 0){
      s = Math.max(0, s + vib * 0.6);  // less saturated
    }

    return rgbToHex(hslToRgb([h, s, l]));
  });

  // redraw the subway with the new colors
  drawMap(displayColors);

  // update the sticky bar swatches too
  const stickySwatches = document.querySelectorAll(".stickybar__sw");
  stickySwatches.forEach((sw, i) => {
    const newHex = displayColors[i];
    if (!newHex) return;
    sw.style.background = newHex;
    sw.dataset.hex = newHex;
  });

  // and the css vars (so the city label etc still match)
  const root = document.documentElement;
  displayColors.slice(0, 5).forEach((c, i) => {
    root.style.setProperty("--c" + (i + 1), c);
  });
}

// hook up the sliders
[ctrlVib, ctrlHue, ctrlSat].forEach((el) => {
  el.addEventListener("input", applyControls);
});

// refresh button = put sliders back to 0 and redraw with original colors
ctrlReset.addEventListener("click", () => {
  ctrlVib.value = 0;
  ctrlHue.value = 0;
  ctrlSat.value = 0;
  applyControls();
});


// ======================================================
// landing page subway — clean organized map, primary colors,
// no animation, no gradient seam
// ======================================================

// vibrant primary + secondary colors only
const LANDING_COLORS = [
  "#e30613",   // red
  "#fcd116",   // yellow
  "#005bbb",   // blue
  "#009a44",   // green
  "#ff6a13",   // orange
  "#7d3f98",   // purple
];
// clean grid: horizontals at y=140/300/500/700/860, verticals at
// x=400/800/1200, plus two simple diagonals connecting corners.
// every segment is horizontal, vertical, or 45° (vignelli rules).
const LANDING_ROUTES = [
  // 1) top horizontal — straight across
  [[-100, 140], [1720, 140]],

  // 2) upper horizontal — one clean bend down to the middle band
  [[-100, 300], [600, 300], [800, 500], [1720, 500]],

  // 3) middle horizontal — straight across
  [[-100, 500], [1720, 500]],

  // 4) lower horizontal — one clean bend up to the middle band
  [[-100, 700], [600, 700], [800, 500], [1720, 500]],

  // 5) bottom horizontal — straight across
  [[-100, 860], [1720, 860]],

  // 6) left vertical — straight down
  [[400, -100], [400, 1100]],

  // 7) center vertical — straight down
  [[800, -100], [800, 1100]],

  // 8) right vertical — straight down
  [[1200, -100], [1200, 1100]],

  // 9) diagonal — top-left to bottom-right, locked to 45°
  [[-100, 100], [400, 600], [1200, 600], [1720, 1100]],

  // 10) diagonal — bottom-left to top-right, locked to 45°
  [[-100, 1100], [400, 600], [1200, 600], [1720, 100]],
];

// build one solid-color line (no gradient, no front, no rider).
// landing page lines arent clickable — its purely decorative,
// no hex pin or copy-to-clipboard until the user searches a city.
function landingLine(points, color){
  const dAttr = polyPath(points);
  const path = svg("path", {
    d: dAttr,
    stroke: color,
    class: "line landing-line",   // extra class so we can disable clicks
  });
  linesLayer.appendChild(path);

  // a solid circle at the END of the line (not animated, not clickable)
  const last = points[points.length - 1];
  const dot = svg("circle", {
    cx: last[0], cy: last[1], r: 16,
    class: "rider landing-line", fill: color,
  });
  ridersLayer.appendChild(dot);
}

// remember the line + dot pairs so we can recolor them later
let landingPairs = [];
let landingTimer = null;

function drawLandingMap(){
  // dont draw landing map if a city has already been loaded
  if (document.body.classList.contains("searched")) return;

  // wipe layers + stop any running animation so nothing moves
  if (animation && animation.rafId) cancelAnimationFrame(animation.rafId);
  animation = null;
  if (landingTimer) clearInterval(landingTimer);

  linesLayer.innerHTML    = "";
  frontsLayer.innerHTML   = "";
  stationsLayer.innerHTML = "";
  ridersLayer.innerHTML   = "";
  defsEl.innerHTML        = "";
  landingPairs = [];

  // small perpendicular offsets so parallel lines on the same axis
  // dont overlap perfectly
  const OFFSETS = [0, 20, -20, 40, -40, 60, -60, 80];

  LANDING_ROUTES.forEach((points, i) => {
    const color   = LANDING_COLORS[i % LANDING_COLORS.length];
    const shifted = offsetRoute(points, OFFSETS[i] || 0);
    landingLine(shifted, color);

    // grab the path + dot we just made so we can recolor them
    const path = linesLayer.lastElementChild;
    const dot  = ridersLayer.lastElementChild;
    landingPairs.push({ path: path, dot: dot });
  });

  // every couple seconds shuffle the colors around
  landingTimer = setInterval(() => {
    if (document.body.classList.contains("searched")){
      clearInterval(landingTimer);
      return;
    }
    // pick a random color from LANDING_COLORS for each line
    landingPairs.forEach((pair) => {
      const c = LANDING_COLORS[Math.floor(Math.random() * LANDING_COLORS.length)];
      pair.path.setAttribute("stroke", c);
      pair.path.dataset.hex = c;
      pair.dot.setAttribute("fill", c);
      pair.dot.dataset.hex = c;
    });
  }, 1500);
}

// kick it off on page load
drawLandingMap();



// drag the landing concept card around the screen

(function makeConceptDraggable(){
  const card = document.querySelector(".concept");
  if (!card) return;

  let dragging = false;
  let offsetX = 0, offsetY = 0;

  card.addEventListener("pointerdown", (event) => {
    // dont start a drag if they clicked on an input/button/chip
    if (event.target.closest("input, button, .chip")) return;

    dragging = true;
    card.classList.add("dragging");
    const rect = card.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;

    // pin it to top/left so we can move it freely
    card.style.position = "fixed";
    card.style.margin   = "0";
    card.style.left     = rect.left + "px";
    card.style.top      = rect.top + "px";
    card.style.zIndex   = "20";

    card.setPointerCapture(event.pointerId);
  });

  card.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    card.style.left = (event.clientX - offsetX) + "px";
    card.style.top  = (event.clientY - offsetY) + "px";
  });

  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("dragging");
    if (card.releasePointerCapture) card.releasePointerCapture(event.pointerId);
  };
  card.addEventListener("pointerup", stop);
  card.addEventListener("pointercancel", stop);
})();



// drag the controls card around the screen

(function makeControlsDraggable(){
  const card = document.querySelector(".stickybar__controls");
  if (!card) return;

  let dragging = false;
  let offsetX = 0, offsetY = 0;

  card.addEventListener("pointerdown", (event) => {
    // dont start a drag if the user clicked an input/slider/button
    if (event.target.closest("input, button")) return;

    dragging = true;
    card.classList.add("dragging");
    const rect = card.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;

    // switch to top/left positioning so we can drag freely
    card.style.right = "auto";
    card.style.left  = rect.left + "px";
    card.style.top   = rect.top + "px";

    card.setPointerCapture(event.pointerId);
  });

  card.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    card.style.left = (event.clientX - offsetX) + "px";
    card.style.top  = (event.clientY - offsetY) + "px";
  });

  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("dragging");
    if (card.releasePointerCapture) card.releasePointerCapture(event.pointerId);
  };
  card.addEventListener("pointerup", stop);
  card.addEventListener("pointercancel", stop);
})();

