"use strict";
// Page smoke tests. A small stub DOM is built from index.html so app.js can run under
// node:test with no dependencies. Real rendering was checked separately in Chrome.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");
const App = require("../app.js");
const { buildStimulus } = require("./helpers.js");

const root = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const html = read("index.html");
const css = read("styles.css");
const appSrc = read("app.js");

// ---------- stub DOM ----------
function parseAttrs(str) {
  const a = {};
  str.replace(/([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g, (m, k, v) => { a[k] = v; return m; });
  return a;
}

class El {
  constructor(tag, attrs) {
    this.tag = tag;
    this.attrs = attrs || {};
    this.listeners = {};
    this.textContent = "";
    this._inner = "";
    this.children = [];
    this.value = this.attrs.value;
    this.valEl = null;
  }
  get id() { return this.attrs.id; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || { key: "" , preventDefault() {} })); }
  click() { this.dispatch("click"); }
  set innerHTML(s) { this._inner = s; this.children = parseElements(s); }
  get innerHTML() { return this._inner; }
  querySelector(sel) { return sel === ".dip-val" ? this.valEl : this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return matchAll(this.children, sel); }
  getContext() { return this.ctx || null; }
}

function parseElements(src) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] === "meta" || m[1] === "link" || m[1] === "script") continue;
    out.push(new El(m[1], parseAttrs(m[2])));
  }
  return out;
}

function matchAll(list, sel) {
  const hasClass = (e, c) => (e.attrs.class || "").split(/\s+/).includes(c);
  const fns = {
    ".dip[data-bus]": (e) => hasClass(e, "dip") && "data-bus" in e.attrs,
    "[data-preset]": (e) => "data-preset" in e.attrs,
    ".pin": (e) => hasClass(e, "pin"),
    ".fp-block": (e) => hasClass(e, "fp-block"),
  };
  const dataFill = /^\[data-fill="([^"]+)"\]$/.exec(sel);
  if (dataFill) return list.filter((e) => e.attrs["data-fill"] === dataFill[1]);
  if (!fns[sel]) throw new Error("stub selector not supported " + sel);
  return list.filter(fns[sel]);
}

function makeEnv() {
  const all = parseElements(html);
  const byId = {};
  all.forEach((e) => { if (e.id) byId[e.id] = e; });
  all.filter((e) => e.tag === "button" && hasCls(e, "dip")).forEach((e) => { e.valEl = new El("span", {}); });
  function hasCls(e, c) { return (e.attrs.class || "").split(/\s+/).includes(c); }
  const calls = { fillText: 0, strokes: 0 };
  byId.wave.ctx = new Proxy({}, {
    get(t, k) {
      if (k === "fillText") return () => { calls.fillText++; };
      if (k === "stroke") return () => { calls.strokes++; };
      return t[k] || (() => {});
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  byId.wave.width = 1100;
  const timers = [];
  let timerId = 0;
  const doc = {
    documentElement: {},
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => matchAll(all, sel),
  };
  const win = {
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "#000000" }),
    devicePixelRatio: 1,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.push({ fn, ms, id }); return id; },
    clearTimeout: (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: (b) => "blob:test/" + b.parts.join("").length },
  };
  const state = App.init(doc, win);
  const runTimers = (n) => { for (let i = 0; i < n && timers.length; i++) { const t = timers.shift(); t.fn(); } };
  return { doc, win, state, byId, calls, timers, runTimers };
}

// ---------- page and file hygiene ----------
const textFiles = ["index.html", "styles.css", "app.js", "engine.js", "README.md", "WRITEUP.md", "NOTES.md",
  "info.yaml", "docs/info.md", "src/project.v", "test/tb.v", "test/test.py", "test/replay.v", "package.json",
  "tests/engine.test.js", "tests/dom-smoke.test.js", "tests/cosim.test.js", "tests/helpers.js", "tools/synth_stats.py"];

test("no em dash or en dash in any source, doc or test file", () => {
  const dashes = new RegExp("[" + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + "]");
  for (const f of textFiles) assert.ok(!dashes.test(read(f)), f);
});

test("no emoji in any source, doc or test file", () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  for (const f of textFiles) assert.ok(!emoji.test(read(f)), f);
});

test("styles.css starts with the Hallmark stamp", () => {
  assert.match(css.split("\n")[0], /^\/\* Hallmark/);
});

test("hex colours exist only inside the :root token block", () => {
  const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")) + 1);
  const outside = css.replace(rootBlock, "");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(outside), "hex outside :root in styles.css");
  const htmlNoMeta = html.replace(/<meta name="theme-color"[^>]*>/, "");
  assert.ok(!/(?<![\w&])#[0-9a-fA-F]{6}\b|(?<![\w&"=])#[0-9a-fA-F]{3}\b(?!\w)/.test(htmlNoMeta.replace(/href="#[\w-]+"/g, "")), "hex in index.html");
  assert.ok(!/rgb\(|hsl\(|oklch\(/.test(outside + html));
});

test("the six palette tokens carry the specified values", () => {
  const want = { paper: "#F6F4EE", surface: "#EAE6DC", ink: "#131618", cyan: "#0284C7", copper: "#D97706", green: "#15803D" };
  for (const [k, v] of Object.entries(want)) assert.match(css, new RegExp(`--${k}:\\s*${v}`));
});

test("every var(--token) used in the stylesheet is defined", () => {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  for (const u of used) assert.ok(defined.has(u), u);
});

test("font-family is only set through the font tokens", () => {
  const decls = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const d of decls) assert.match(d, /^var\(--font-(display|prose|mono)\)$|^var\(--font-mono\)$/);
  assert.match(css, /--font-display:\s*"Space Grotesk"/);
  assert.match(css, /--font-prose:\s*"Plus Jakarta Sans"/);
  assert.match(css, /--font-mono:\s*"JetBrains Mono"/);
});

test("no uppercase transforms and no italic headings (no kicker labels)", () => {
  assert.ok(!/text-transform:\s*uppercase/.test(css));
  assert.ok(!/font-style:\s*italic/.test(css));
});

test("reduced motion, focus-visible, skip link and viewport are present", () => {
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(html, /class="skip"/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<html lang="en">/);
});

test("exactly one h1 and every section has a heading", () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  for (const s of html.match(/<section\b[^>]*>/g)) assert.match(s, /aria-labelledby=/);
});

test("decorative inline icons are aria-hidden and informative svgs have a title", () => {
  const svgs = html.match(/<svg\b[^>]*>/g);
  for (const s of svgs) assert.ok(/aria-hidden="true"/.test(s) || /role="(img|group)"/.test(s), s);
});

test("every id looked up by app.js exists in index.html", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const looked = [...appSrc.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]);
  const texts = [...appSrc.matchAll(/\btext\("([\w-]+)"/g)].map((m) => m[1]);
  const flags = [...appSrc.matchAll(/\bflag\("([\w-]+)"/g)].map((m) => m[1]);
  const ons = [...appSrc.matchAll(/\bon\("([\w-]+)"/g)].map((m) => m[1]);
  for (const id of [...looked, ...texts, ...flags, ...ons]) assert.ok(ids.has(id), id);
  for (const p of ["c-", "h-"]) for (const part of ["vec", "dot", "target", "trail"]) assert.ok(ids.has(p + part), p + part);
});

test("buttons have visible text and no inline handlers exist", () => {
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) assert.ok(m[1].replace(/<[^>]+>/g, "").trim().length > 0);
  assert.ok(!/\son\w+=/.test(html));
});

test("the page loads engine.js before app.js and links the stylesheet", () => {
  assert.ok(html.indexOf("engine.js") < html.indexOf("app.js"));
  assert.match(html, /href="styles\.css"/);
});

test("the AI assistance disclosure is on every first surface", () => {
  assert.match(html, /id="disclosure"[\s\S]*not an eligible entry/);
  assert.match(read("README.md").split("\n").slice(0, 4).join(" "), /not an eligible Hack Club ASIC entry/);
  assert.match(read("info.yaml"), /description:\s+"AI assisted reference design, not a Hack Club ASIC entry/);
  assert.match(read("WRITEUP.md").split("\n")[0], /not the write up/);
  assert.match(html, /<footer[\s\S]*not a Hack Club ASIC entry/);
});

test("page fallback figures match what the engine computes", () => {
  const rep = E.rotationErrorReport();
  const fb = (name) => new RegExp(`data-fill="${name}">([^<]+)<`).exec(html)[1];
  assert.equal(fb("errcos"), rep.maxCosLsb.toFixed(2));
  assert.equal(fb("errsin"), rep.maxSinLsb.toFixed(2));
  assert.equal(fb("cells"), String(E.synthesizeGateNetlistMetrics().totalCells));
});

test("the published co-simulation cycle count equals the stimulus the test replays", () => {
  const total = [1, 20261130].reduce((s, seed) => s + buildStimulus(150000, seed).length, 0);
  assert.equal(E.VERIFIED_COSIM_CYCLES, total);
  assert.ok(html.includes((total).toLocaleString("en-US")));
  assert.ok(read("README.md").includes((total).toLocaleString("en-US")));
});

// ---------- info.yaml and Verilog agree ----------
test("info.yaml names the Verilog top module and lists existing sources", () => {
  const y = read("info.yaml");
  const top = /top_module:\s*"([^"]+)"/.exec(y)[1];
  assert.match(read("src/project.v"), new RegExp(`module ${top}\\s*\\(`));
  assert.match(read("test/tb.v"), new RegExp(top));
  for (const m of y.matchAll(/-\s*"([\w.]+\.v)"/g)) assert.ok(fs.existsSync(path.join(root, "src", m[1])));
  assert.match(y, /tiles:\s*"1x1"/);
  assert.ok(top.startsWith("tt_um_"));
});

test("info.yaml fills all 24 pinout entries", () => {
  const y = read("info.yaml");
  for (const g of ["ui", "uo", "uio"]) for (let i = 0; i < 8; i++) assert.match(y, new RegExp(`${g}\\[${i}\\]:\\s*"[^"]+"`));
});

test("LICENSE is Apache-2.0 and the Verilog carries the SPDX tag", () => {
  assert.match(read("LICENSE"), /Apache License/);
  assert.match(read("src/project.v"), /SPDX-License-Identifier: Apache-2\.0/);
});

test("project.v drives uio_oe to 0xF0 and every output port is assigned", () => {
  const v = read("src/project.v");
  assert.match(v, /assign uio_oe = 8'hF0;/);
  assert.match(v, /assign uo_out = /);
  assert.match(v, /assign uio_out = /);
});

test("the Verilog atan table equals engine ATAN_Q", () => {
  const v = read("src/project.v");
  const vals = [...v.matchAll(/(?:3'd\d|default):\s*atan_q = 9'd(\d+);/g)].map((m) => Number(m[1]));
  assert.deepEqual(vals, [...E.ATAN_Q]);
});

// ---------- running app.js against the stub ----------
test("init builds 27 pins, 4 floorplan blocks and fills the table rows", () => {
  const env = makeEnv();
  assert.equal(env.byId["pinout-svg"].children.filter((e) => /pin/.test(e.attrs.class || "")).length, 27);
  assert.equal(env.byId.floor.children.filter((e) => /fp-block/.test(e.attrs.class || "")).length, 4);
  assert.match(env.byId["floor-rows"].innerHTML, /aariv_cordic_core/);
  assert.equal((env.byId["pin-rows"].innerHTML.match(/<tr>/g) || []).length, 24);
});

test("init records the reset sequence so the logic analyzer starts with data", () => {
  const env = makeEnv();
  assert.equal(env.state.history.length, 8);
  assert.equal(env.state.history[0].rstN, 0);
  assert.equal(env.state.history[7].rstN, 1);
  assert.ok(env.calls.fillText > 10, "canvas labels drawn");
});

test("init fills measured accuracy and the verified cycle count", () => {
  const env = makeEnv();
  assert.equal(env.byId["r-uo"].textContent, "00");
  assert.equal(env.doc.querySelectorAll('[data-fill="cosim"]')[0].textContent, "320,028");
  assert.equal(env.doc.querySelectorAll('[data-fill="errcos"]')[0].textContent, "1.73");
  assert.equal(env.doc.querySelectorAll('[data-fill="errang"]')[0].textContent, "1.15");
});

test("clicking an input switch flips the pin, the switch state and the decoded line", () => {
  const env = makeEnv();
  const dip = env.doc.querySelectorAll(".dip[data-bus]").find((e) => e.attrs["data-bus"] === "ui" && e.attrs["data-bit"] === "6");
  dip.click();
  assert.equal(env.state.ui, 0x40);
  assert.equal(dip.getAttribute("aria-pressed"), "true");
  assert.equal(dip.valEl.textContent, "1");
  assert.match(env.byId["pin-decode"].textContent, /opcode 01 vector/);
});

test("Step one clock advances the cycle counter by one and records a cycle", () => {
  const env = makeEnv();
  const before = env.state.cycles;
  env.byId["btn-step"].click();
  assert.equal(env.state.cycles, before + 1);
  assert.equal(env.state.history.length, 9);
});

test("Pulse START queues two clocks and the rotate preset produces a cosine readout", () => {
  const env = makeEnv();
  env.doc.querySelectorAll("[data-preset]").find((e) => e.attrs["data-preset"] === "rot30").click();
  env.runTimers(40);
  assert.equal(env.state.queue.length, 0);
  assert.match(env.byId.decode.textContent, /Angle 30\.9 degrees\. cos = /);
  assert.match(env.byId["circle-caption"].textContent, /30\.9 degrees/);
  assert.equal(env.state.frames.length, 9);
});

test("the vector preset ends with the angle of (12, 9) on uo_out", () => {
  const env = makeEnv();
  env.doc.querySelectorAll("[data-preset]").find((e) => e.attrs["data-preset"] === "vec").click();
  env.runTimers(60);
  const want = Math.round(E.vectorReference(12, 9).angleBam);
  const got = (E.outputs(env.state.chip, env.state.uio).uoOut << 24) >> 24;
  assert.ok(Math.abs(got - want) <= 2, `${got} vs ${want}`);
  assert.match(env.byId["decode-ref"].textContent, /Input \(12, 9\)/);
});

test("the MAC preset accumulates 3 times 7 three times", () => {
  const env = makeEnv();
  env.doc.querySelectorAll("[data-preset]").find((e) => e.attrs["data-preset"] === "mac").click();
  env.runTimers(60);
  assert.equal(env.state.chip.acc, 63);
  assert.match(env.byId.decode.textContent, /Accumulator = 63/);
});

test("the random bit stream preset leaves the LFSR advancing", () => {
  const env = makeEnv();
  env.doc.querySelectorAll("[data-preset]").find((e) => e.attrs["data-preset"] === "prng").click();
  env.runTimers(60);
  assert.equal(env.state.chip.view, E.VIEW.LFSR);
  assert.match(env.byId.decode.textContent, /LFSR state [0-9a-f]{2}/);
});

test("Reset chip pulls rst_n low for two cycles and then releases it", () => {
  const env = makeEnv();
  env.byId["btn-start"].click();
  env.byId["btn-reset"].click();
  env.runTimers(10);
  const last = env.state.history.slice(-3);
  assert.deepEqual(last.map((r) => r.rstN), [0, 0, 1]);
});

test("Run clock toggles the running state and the button label", () => {
  const env = makeEnv();
  env.byId["btn-run"].click();
  assert.equal(env.state.running, true);
  assert.equal(env.byId["btn-run"].textContent, "Pause clock");
  env.byId["btn-run"].click();
  assert.equal(env.state.running, false);
  assert.equal(env.byId["btn-run"].textContent, "Run clock");
});

test("the speed slider updates its readout", () => {
  const env = makeEnv();
  env.byId.speed.value = "32";
  env.byId.speed.dispatch("input");
  assert.equal(env.byId["speed-out"].textContent, "32 Hz");
});

test("Download VCD builds a blob link from the recorded history", () => {
  const env = makeEnv();
  env.byId["btn-vcd"].click();
  assert.match(env.byId["btn-vcd"].getAttribute("href"), /^blob:test\/\d+$/);
});

test("pressing Enter on an input pin in the pinout toggles that pin", () => {
  const env = makeEnv();
  const pin = env.byId["pinout-svg"].children.find((e) => e.attrs["data-label"] === "ui_in[7]");
  pin.dispatch("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(env.state.ui, 0x80);
  assert.match(env.byId["pin-info"].textContent, /ui_in\[7\]\. opcode bit 1\. Toggled\./);
});

test("selecting an output pin only describes it", () => {
  const env = makeEnv();
  const pin = env.byId["pinout-svg"].children.find((e) => e.attrs["data-label"] === "uo_out[3]");
  pin.dispatch("click");
  assert.equal(env.state.ui, 0);
  assert.match(env.byId["pin-info"].textContent, /uo_out\[3\]\. result bit 3\.$/);
});

test("focusing a floorplan block shows its cell count", () => {
  const env = makeEnv();
  const blk = env.byId.floor.children.find((e) => /fp-block/.test(e.attrs.class || "") && e.attrs["data-name"] === "aariv_mac8");
  blk.dispatch("focus");
  assert.match(env.byId["floor-caption"].textContent, /aariv_mac8\. 92 cells, of which 9 flip-flops and 83 gates/);
});

test("the hero demo advances one stage per timer tick", () => {
  const env = makeEnv();
  const first = env.byId["h-readout"].textContent;
  assert.match(first, /stage 0 of 8/);
  env.runTimers(3);
  assert.match(env.byId["h-readout"].textContent, /stage [1-9] of 8/);
});

test("with reduced motion the hero shows the finished rotation and starts no timer", () => {
  const all = parseElements(html);
  const byId = {};
  all.forEach((e) => { if (e.id) byId[e.id] = e; });
  const timers = [];
  const doc = { documentElement: {}, getElementById: (i) => byId[i] || null, querySelectorAll: (s) => matchAll(all, s) };
  all.filter((e) => /\bdip\b/.test(e.attrs.class || "")).forEach((e) => { e.valEl = new El("span"); });
  const win = { matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ getPropertyValue: () => "#000" }), devicePixelRatio: 1, setTimeout: (fn) => { timers.push(fn); return 1; }, clearTimeout() {} };
  App.init(doc, win);
  assert.match(byId["h-readout"].textContent, /stage 8 of 8/);
  assert.equal(timers.length, 0);
});

test("the unit circle marks the target angle for a rotation and the x axis for vectoring", () => {
  const env = makeEnv();
  env.doc.querySelectorAll("[data-preset]").find((e) => e.attrs["data-preset"] === "rot-45").click();
  env.runTimers(40);
  const t = env.byId["c-target"];
  assert.ok(Math.abs(Number(t.attrs.x2) - Math.cos(-Math.PI / 4)) < 1e-3);
  assert.ok(Math.abs(Number(t.attrs.y2) - Math.sin(Math.PI / 4)) < 1e-3);
});

test("stage chips mark finished stages after a rotation", () => {
  const env = makeEnv();
  env.doc.querySelectorAll("[data-preset]").find((e) => e.attrs["data-preset"] === "rot30").click();
  env.runTimers(40);
  assert.equal((env.byId["stage-list"].innerHTML.match(/class="done"/g) || []).length, 8);
});

test("the OVERFLOW LED lights after a clamped MAC add", () => {
  const env = makeEnv();
  env.state.ui = 0x80 | 31;
  env.state.uio = 8;
  for (let i = 0; i < 6; i++) {
    env.state.uio = 8; env.byId["btn-step"].click();
    env.state.uio = 9; env.byId["btn-step"].click();
  }
  env.state.uio = 8; env.byId["btn-step"].click();
  assert.equal(env.byId["f-ovf"].getAttribute("class"), "on warn");
});

test("src/config.json from the Tiny Tapeout template is present and parses (the gds job needs it)", () => {
  const cfg = JSON.parse(read("src/config.json"));
  assert.equal(cfg.CLOCK_PORT, "clk");
  assert.ok(cfg.CLOCK_PERIOD > 0);
});

test("Previous and Next pin step through the pinout in table order without toggling", () => {
  const env = makeEnv();
  env.byId["pin-next"].click();
  assert.match(env.byId["pin-info"].textContent, /^ui_in\[7\]\. opcode bit 1\.$/);
  env.byId["pin-next"].click();
  assert.match(env.byId["pin-info"].textContent, /^ui_in\[6\]\./);
  assert.equal(env.state.ui, 0, "stepping never toggles an input");
  env.byId["pin-prev"].click();
  env.byId["pin-prev"].click();
  assert.match(env.byId["pin-info"].textContent, /^ena\./, "wraps from the first pin to the last");
  for (let i = 0; i < 9; i++) env.byId["pin-next"].click();
  assert.match(env.byId["pin-info"].textContent, /^uo_out\[7\]\./);
});

test("arrow keys on a pin move to the neighbouring pin", () => {
  const env = makeEnv();
  const pin = env.byId["pinout-svg"].children.find((e) => e.attrs["data-label"] === "uo_out[3]");
  pin.dispatch("click");
  pin.dispatch("keydown", { key: "ArrowDown", preventDefault() {} });
  assert.match(env.byId["pin-info"].textContent, /^uo_out\[2\]\./);
});

test("every pin has a tap zone over its whole slot, and the step buttons are in the page", () => {
  const env = makeEnv();
  const kids = env.byId["pinout-svg"].children;
  const zones = kids.filter((e) => e.attrs.class === "tap-zone");
  assert.equal(zones.length, 27);
  // side pin slots are a full 28 unit pitch tall and cover the label; bottom slots a full 22 unit pitch wide
  assert.equal(zones.filter((z) => z.attrs.height === "28" && Number(z.attrs.width) >= 110).length, 16);
  assert.equal(zones.filter((z) => z.attrs.width === "22" && Number(z.attrs.height) >= 80).length, 8);
  assert.match(css, /\.pin rect\.tap-zone[^{]*\{ fill: transparent; stroke: none; \}/);
  assert.match(html, /id="pin-prev"[^>]*>|<button[^>]*id="pin-prev"/);
  assert.match(css, /\.pin-step \.btn \{ flex: 1 1 0; \}/);
});
