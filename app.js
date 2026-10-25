/*
 * app.js: the workbench UI. All chip behaviour comes from engine.js; this file only
 * wires switches, a clock, a canvas logic analyzer, a unit circle and a floorplan sketch.
 * init(doc, win) takes its document so tests/dom-smoke.test.js can drive it with a stub.
 */
(function (root, factory) {
  const E = typeof module === "object" && module.exports ? require("./engine.js") : root.CordicEngine;
  const api = factory(E);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.CordicApp = api;
    if (typeof document !== "undefined" && document.getElementById("wave")) api.init(document, window);
  }
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";

  const WAVE_CYCLES = 30;
  const HISTORY_MAX = 4000;
  const LOGICAL_W = 1100;
  const LOGICAL_H = 420;
  const DEG_PER_UNIT = 180 / 64;

  const PIN_ROLES = {
    ui: ["A0, operand bit 0", "A1", "A2", "A3", "A4", "A5, operand sign bit", "opcode bit 0", "opcode bit 1"],
    uo: ["result bit 0", "result bit 1", "result bit 2", "result bit 3", "result bit 4", "result bit 5", "result bit 6", "result bit 7, sign of a signed result"],
    uio: ["START, rising edge runs the operation", "MODE, selects the second form of an operation", "RSEL, shows the second result on uo_out", "GAIN3, MAC gain of 3 instead of 1", "BUSY, high while the CORDIC runs (output)", "ZERO, uo_out is 00 (output)", "OVERFLOW, saturated result (output)", "SIGN, copy of uo_out[7] (output)"],
  };
  const OPCODES = ["rotate", "vector", "mac", "prng and crc"];
  const VIEW_NAMES = ["rotate", "vector", "mac", "lfsr", "crc"];

  const s6 = (v) => (v << 26) >> 26;
  const hex = (v, w) => (v >>> 0).toString(16).padStart(w, "0");

  function init(doc, win) {
    const $ = (id) => doc.getElementById(id);
    const S = {
      chip: E.createChip(),
      ui: 0,
      uio: 0,
      rstN: 1,
      history: [],
      running: false,
      timer: null,
      queue: [],
      frames: [],
      lastOp: null,
      selectedPin: null,
      cycles: 0,
    };
    E.resetSequence(S.chip, 2);
    S.chip.cycle = 0;

    const reduced = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);

    // ---------- small helpers ----------
    const text = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const cssVar = (name) => {
      try { return win.getComputedStyle(doc.documentElement).getPropertyValue(name).trim() || "#000"; }
      catch (e) { return "#000"; }
    };
    const fill = (name, v) => {
      const list = doc.querySelectorAll ? doc.querySelectorAll(`[data-fill="${name}"]`) : [];
      Array.prototype.forEach.call(list, (el) => { el.textContent = v; });
    };

    // ---------- pins ----------
    function syncSwitches() {
      const set = (el, on) => {
        el.setAttribute("aria-pressed", on ? "true" : "false");
        const v = el.querySelector ? el.querySelector(".dip-val") : null;
        if (v) v.textContent = on ? "1" : "0";
      };
      Array.prototype.forEach.call(doc.querySelectorAll(".dip[data-bus]"), (el) => {
        const bit = Number(el.getAttribute("data-bit"));
        const val = el.getAttribute("data-bus") === "ui" ? S.ui : S.uio;
        set(el, (val >> bit) & 1);
      });
      const rst = $("dip-rstn");
      if (rst) set(rst, S.rstN);
    }

    function describePins() {
      const p = E.decodePins(S.ui, S.uio);
      let s = `opcode ${p.op.toString(2).padStart(2, "0")} ${OPCODES[p.op]}, A = ${p.a}`;
      if (p.op === 0) s += ` (${(p.a * DEG_PER_UNIT).toFixed(1)} degrees)`;
      s += `, START ${p.startPin}, MODE ${p.mode}, RSEL ${p.rsel}, GAIN3 ${p.gain3}`;
      text("pin-decode", s);
    }

    function toggleBit(bus, bit) {
      if (bus === "ui") S.ui ^= 1 << bit; else S.uio ^= 1 << bit;
      syncSwitches();
      describePins();
      renderOutputs();
      renderPinout();
    }

    // ---------- clock ----------
    function applyQueueItem(item) {
      if (item.ui !== undefined) S.ui = item.ui & 0xff;
      if (item.uio !== undefined) S.uio = item.uio & 0x0f;
      if (item.rst !== undefined) S.rstN = item.rst;
      syncSwitches();
      describePins();
    }

    function clockOnce() {
      if (S.queue.length) applyQueueItem(S.queue.shift());
      const chip = S.chip;
      const wasBusy = chip.busy;
      const startRises = (S.uio & 1) && !chip.startQ && !wasBusy && S.rstN;
      const xinBefore = chip.xin;
      const rec = E.stepClock(chip, S.ui, S.uio, S.rstN);
      S.cycles = chip.cycle;
      S.history.push(rec);
      if (S.history.length > HISTORY_MAX) S.history.shift();
      if (!wasBusy && chip.busy && startRises) {
        const op = (S.ui >> 6) & 3;
        S.lastOp = { op, a: s6(S.ui & 63), xin: s6(xinBefore & 63) };
        S.frames = [{ x: chip.x, y: chip.y, z: chip.z }];
      } else if (chip.busy || (wasBusy && S.frames.length && S.frames.length < 9)) {
        S.frames.push({ x: chip.x, y: chip.y, z: chip.z });
      }
      if (!S.rstN) { S.frames = []; S.lastOp = null; }
      renderAll();
    }

    function tickRate() {
      const hz = Number(($("speed") || { value: 4 }).value) || 4;
      return S.queue.length ? Math.max(hz, 8) : hz;
    }
    function scheduleTick() {
      if (S.timer) win.clearTimeout(S.timer);
      S.timer = null;
      if (!S.running && !S.queue.length) { updateRunButton(); return; }
      S.timer = win.setTimeout(() => { clockOnce(); scheduleTick(); }, 1000 / tickRate());
      updateRunButton();
    }
    function updateRunButton() {
      const b = $("btn-run");
      if (b) {
        b.setAttribute("aria-pressed", S.running ? "true" : "false");
        b.textContent = S.running ? "Pause clock" : "Run clock";
      }
    }
    function enqueue(items) { S.queue.push(...items); scheduleTick(); }

    function runPreset(name) {
      const hold = (n, item) => Array.from({ length: n }, () => ({ ...(item || {}) }));
      const pulseStart = (ui, uio) => [{ ui, uio: uio & ~1 }, { ui, uio: uio | 1 }, { ui, uio: uio & ~1 }];
      let q = [{ rst: 1 }];
      if (name === "rot30") q = q.concat(pulseStart(11, 0), hold(10), [{ uio: 4 }]);
      else if (name === "rot-45") q = q.concat(pulseStart((-16) & 63, 0), hold(10), [{ uio: 4 }]);
      else if (name === "vec") {
        q = q.concat(pulseStart(0x40 | 12, 0), [{ ui: 0x40 | 9, uio: 2 }, { uio: 3 }, { uio: 2 }], hold(10), [{ uio: 6 }]);
      } else if (name === "vec-neg") {
        q = q.concat(pulseStart(0x40 | ((-10) & 63), 0), [{ ui: 0x40 | 10, uio: 2 }, { uio: 3 }, { uio: 2 }], hold(10), [{ uio: 6 }]);
      } else if (name === "mac") {
        q = q.concat([{ ui: 0x80 | 7, uio: 10 }, { uio: 11 }, { uio: 10 }], pulseStart(0x80 | 7, 8), pulseStart(0x80 | 7, 8), pulseStart(0x80 | 7, 8), hold(2));
      } else if (name === "prng") q = q.concat(pulseStart(0xc0 | 1, 0), hold(24));
      S.queue = q;
      scheduleTick();
    }

    // ---------- readouts ----------
    function currentOutputs() { return E.outputs(S.chip, S.uio); }

    function renderPinout() {
      const svg = $("pinout-svg");
      if (!svg) return;
      const o = currentOutputs();
      const state = (kind, i) => {
        if (kind === "ui") return (S.ui >> i) & 1;
        if (kind === "uo") return (o.uoOut >> i) & 1;
        return i < 4 ? (S.uio >> i) & 1 : (o.uioOut >> i) & 1;
      };
      Array.prototype.forEach.call(svg.querySelectorAll ? svg.querySelectorAll(".pin") : [], (el) => {
        const kind = el.getAttribute("data-kind");
        if (!kind || kind === "misc") return;
        const i = Number(el.getAttribute("data-i"));
        const hi = state(kind, i);
        const base = el.getAttribute("data-label");
        el.setAttribute("class", `pin${hi ? " hi" : ""}${S.selectedPin === base ? " sel" : ""}`);
        el.setAttribute("aria-label", `${base}, ${hi ? "high" : "low"}`);
      });
    }

    function buildPinout() {
      const svg = $("pinout-svg");
      if (!svg) return;
      let g = '<rect class="chip-body" x="150" y="70" width="220" height="250" rx="4"/>';
      g += '<text class="chip-label" x="260" y="190" text-anchor="middle">tt_um_aariv</text><text class="chip-label" x="260" y="208" text-anchor="middle">_cordic_alu</text><text class="chip-label dim" x="260" y="232" text-anchor="middle">340 x 160 um tile</text>';
      const pin = (kind, i, x, y, w, h, label, role, lx, ly, anchor, rot) => {
        const lab = `${label}[${i}]`;
        return `<g class="pin" tabindex="0" role="button" data-kind="${kind}" data-i="${i}" data-label="${lab}" data-role="${role}" aria-label="${lab}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/><text x="${lx}" y="${ly}" text-anchor="${anchor}"${rot ? ` transform="rotate(-90 ${lx} ${ly})"` : ""}>${lab}</text></g>`;
      };
      for (let i = 0; i < 8; i++) {
        const b = 7 - i;
        g += pin("ui", b, 128, 92 + i * 28, 22, 14, "ui_in", PIN_ROLES.ui[b], 120, 103 + i * 28, "end", false);
        g += pin("uo", b, 370, 92 + i * 28, 22, 14, "uo_out", PIN_ROLES.uo[b], 400, 103 + i * 28, "start", false);
        g += pin("uio", b, 168 + i * 22, 320, 14, 22, "uio", PIN_ROLES.uio[b], 180 + i * 22, 400, "start", true);
      }
      ["clk", "rst_n", "ena"].forEach((n, k) => {
        g += `<g class="pin" tabindex="-1" data-kind="misc" data-label="${n}" data-role="${n === "clk" ? "clock" : n === "rst_n" ? "reset, active low" : "enable, high while powered"}"><rect x="${190 + k * 52}" y="48" width="14" height="22" rx="2"/><text x="${197 + k * 52}" y="40" text-anchor="middle">${n}</text></g>`;
      });
      svg.innerHTML = g;
      const rows = $("pin-rows");
      if (rows) {
        let h = "";
        for (let b = 7; b >= 0; b--) h += `<tr><th scope="row"><code>ui_in[${b}]</code></th><td>input</td><td>${PIN_ROLES.ui[b]}</td></tr>`;
        for (let b = 7; b >= 0; b--) h += `<tr><th scope="row"><code>uo_out[${b}]</code></th><td>output</td><td>${PIN_ROLES.uo[b]}</td></tr>`;
        for (let b = 7; b >= 0; b--) h += `<tr><th scope="row"><code>uio[${b}]</code></th><td>${b < 4 ? "input" : "output"}</td><td>${PIN_ROLES.uio[b]}</td></tr>`;
        rows.innerHTML = h;
      }
      Array.prototype.forEach.call(svg.querySelectorAll(".pin"), (el) => {
        const act = () => {
          const kind = el.getAttribute("data-kind");
          const label = el.getAttribute("data-label");
          S.selectedPin = label;
          const i = Number(el.getAttribute("data-i"));
          let msg = `${label}. ${el.getAttribute("data-role")}.`;
          if (kind === "ui" || (kind === "uio" && i < 4)) { toggleBit(kind, i); msg += " Toggled."; }
          text("pin-info", msg);
          renderPinout();
        };
        el.addEventListener("click", act);
        el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
      });
    }

    function decodeText() {
      const c = S.chip;
      const o = currentOutputs();
      const L = S.lastOp;
      let main = "";
      let ref = "";
      if (c.busy) {
        main = `Working. Stage ${c.iter} of 8 is next. z has ${c.z} units left to turn.`;
      } else if (c.view === E.VIEW.ROTATE) {
        const cos = E.sat8(c.x >> 2);
        const sin = E.sat8(c.y >> 2);
        main = `cos = ${cos}/128 = ${(cos / 128).toFixed(4)}, sin = ${sin}/128 = ${(sin / 128).toFixed(4)}`;
        if (L && L.op === 0) {
          const r = E.rotateReference(L.a);
          main = `Angle ${(L.a * DEG_PER_UNIT).toFixed(1)} degrees. ` + main;
          ref = `Math.cos gives ${r.cos.toFixed(4)} and Math.sin gives ${r.sin.toFixed(4)}.`;
          if ([c.x >> 2, c.y >> 2].some((v) => v > 127 || v < -128)) ref += " A value at or beyond 1.0 does not fit in Q1.7, so it clamps and raises OVERFLOW.";
        }
      } else if (c.view === E.VIEW.VECTOR) {
        const mag = (c.x >> 3) & 0xff;
        const ang = (c.z >> 3) << 24 >> 24;
        main = `length x 1.6467 = ${mag}, angle = ${ang} counts = ${(ang * 1.40625).toFixed(1)} degrees`;
        if (L && L.op === 1) {
          const r = E.vectorReference(L.xin, L.a);
          ref = `Input (${L.xin}, ${L.a}). Expected length x 1.6467 = ${r.mag.toFixed(2)} and angle ${(r.angleBam).toFixed(1)} counts.`;
        }
      } else if (c.view === E.VIEW.MAC) {
        const a = c.acc;
        main = `Accumulator = ${a} (hex ${hex(a & 255, 2)})${c.macSat ? ", last add was clamped" : ""}`;
      } else if (c.view === E.VIEW.LFSR) {
        main = `LFSR state ${hex(c.lfsr, 2)} (${c.lfsr.toString(2).padStart(8, "0")}). It cycles through 255 states.`;
      } else {
        main = `CRC-8 register ${hex(c.crc, 2)} (polynomial 0x07).`;
      }
      text("decode", main);
      text("decode-ref", ref);
      void o;
    }

    function renderOutputs() {
      const c = S.chip;
      const o = currentOutputs();
      text("r-x", hex(c.x & 0x7ff, 3));
      text("r-y", hex(c.y & 0x7ff, 3));
      text("r-z", hex(c.z & 0xfff, 3));
      text("r-iter", String(c.iter));
      text("r-acc", hex(c.acc & 255, 2));
      text("r-lfsr", hex(c.lfsr, 2));
      text("r-crc", hex(c.crc, 2));
      text("r-view", VIEW_NAMES[c.view]);
      text("r-uo", hex(o.uoOut, 2));
      text("r-uio", hex(o.uioOut, 2));
      const flag = (id, on, warn) => {
        const el = $(id);
        if (el) el.setAttribute("class", `${on ? "on" : ""}${warn ? " warn" : ""}`.trim());
      };
      flag("f-busy", o.flags.busy);
      flag("f-zero", o.flags.zero);
      flag("f-ovf", o.flags.overflow, true);
      flag("f-sign", o.flags.sign);
      text("cycle-line", `Clock cycle ${S.cycles}${S.queue.length ? `, ${S.queue.length} scripted steps left` : ""}`);
    }

    // ---------- unit circle ----------
    function circleMarkup(frames, scale) {
      let s = "";
      for (let k = 0; k < frames.length; k++) {
        const x = (frames[k].x * scale).toFixed(4);
        const y = (-frames[k].y * scale).toFixed(4);
        if (k > 0) {
          const px = (frames[k - 1].x * scale).toFixed(4);
          const py = (-frames[k - 1].y * scale).toFixed(4);
          s += `<line x1="${px}" y1="${py}" x2="${x}" y2="${y}"/>`;
        }
        s += `<circle cx="${x}" cy="${y}" r="0.022"/>`;
      }
      return s;
    }

    function drawCircle(p, frames, scale, targetRad) {
      const set = (id, attrs) => { const el = $(id); if (el) Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k])); };
      const last = frames[frames.length - 1] || { x: 0, y: 0 };
      const px = (last.x * scale).toFixed(4);
      const py = (-last.y * scale).toFixed(4);
      set(p + "vec", { x2: px, y2: py });
      set(p + "dot", { cx: px, cy: py });
      set(p + "target", targetRad === null ? { x2: "0", y2: "0" } : { x2: Math.cos(targetRad).toFixed(4), y2: (-Math.sin(targetRad)).toFixed(4) });
      const trail = $(p + "trail");
      if (trail) trail.innerHTML = circleMarkup(frames.slice(0, -1), scale);
    }

    function renderCircle() {
      const L = S.lastOp;
      const frames = S.frames.length ? S.frames : [{ x: E.ROTATE_X0, y: 0, z: 0 }];
      let scale = 1 / 512;
      let target = null;
      if (L && L.op === 1) {
        const r0 = Math.hypot(frames[0].x, frames[0].y) || 512;
        scale = 1 / (E.CORDIC_GAIN * r0);
        target = 0;
      } else if (L && L.op === 0) {
        target = (L.a * Math.PI) / 64;
      }
      drawCircle("c-", frames, scale, target);
      const cap = $("circle-caption");
      if (cap) {
        if (!L) cap.textContent = "Idle. Pulse START in rotate or vector mode to see the eight micro-rotations.";
        else if (L.op === 0) cap.textContent = `Rotating by ${(L.a * DEG_PER_UNIT).toFixed(1)} degrees. The dashed copper line is the target angle.`;
        else cap.textContent = "Vectoring turns the input vector onto the x axis. The angle it turned through ends up in z.";
      }
      const list = $("stage-list");
      if (list) {
        const done = Math.max(0, S.frames.length - 1);
        let h = "";
        for (let i = 0; i < 8; i++) {
          const cls = i < done ? "done" : i === done && S.chip.busy ? "now" : "";
          const deg = (E.ATAN_Q[i] / 16) * DEG_PER_UNIT;
          h += `<li class="${cls}">i = ${i}<br>${deg.toFixed(2)} deg</li>`;
        }
        list.innerHTML = h;
      }
    }

    // ---------- waveform ----------
    // The canvas is drawn at the width it is shown at, so labels stay readable on a phone
    // and the number of clock cycles on screen follows the width.
    const waveWrap = $("wave-wrap");
        function drawWave() {
      const cv = $("wave");
      if (!cv || !cv.getContext) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const k = Math.min(2, win.devicePixelRatio || 1);
      const shown = waveWrap && waveWrap.clientWidth ? waveWrap.clientWidth : LOGICAL_W;
      const WW = Math.max(340, Math.min(LOGICAL_W, shown));
      const NCYC = Math.max(8, Math.floor((WW - (WW < 600 ? 72 : 92) - 8) / 33));
      if (cv.width !== WW * k || cv.height !== LOGICAL_H * k) { cv.width = WW * k; cv.height = LOGICAL_H * k; }
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const ink = cssVar("--ink");
      const faint = cssVar("--line-strong");
      const cyan = cssVar("--cyan");
      const copper = cssVar("--copper");
      const green = cssVar("--green");
      const paper = cssVar("--paper");
      const mono = cssVar("--font-mono");
      ctx.clearRect(0, 0, WW, LOGICAL_H);
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, WW, LOGICAL_H);

      const lanes = [
        { n: "clk", kind: "clk" },
        { n: "rst_n", kind: "bit", get: (r) => r.rstN, color: ink },
        { n: "ui_in", kind: "bus", w: 8, get: (r) => r.uiIn, color: cyan },
        { n: "uio_in", kind: "bus", w: 8, get: (r) => r.uioIn, color: cyan },
        { n: "uo_out", kind: "bus", w: 8, get: (r) => r.uoOut, color: copper },
        { n: "uio_out", kind: "bus", w: 8, get: (r) => r.uioOut, color: copper },
        { n: "x_reg", kind: "bus", w: 11, get: (r) => r.x, color: green },
        { n: "y_reg", kind: "bus", w: 11, get: (r) => r.y, color: green },
        { n: "z_reg", kind: "bus", w: 12, get: (r) => r.z, color: green },
        { n: "iter", kind: "bus", w: 3, get: (r) => r.iter, color: green },
      ];
      const gutter = WW < 600 ? 72 : 92;
      const top = 8;
      const laneH = (LOGICAL_H - top - 22) / lanes.length;
      const recs = S.history.slice(-NCYC);
      const cw = (WW - gutter - 8) / NCYC;
      const x0 = gutter + (NCYC - recs.length) * cw;

      const soft = cssVar("--ink-soft");
      ctx.font = `11px ${mono}`;
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1;
      // faint cycle grid, one line per clock, so the time axis reads even before data arrives
      ctx.strokeStyle = faint;
      ctx.globalAlpha = 0.14;
      for (let c = 0; c <= NCYC; c++) {
        const gx = gutter + c * cw;
        ctx.beginPath(); ctx.moveTo(gx, top); ctx.lineTo(gx, LOGICAL_H - 22); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      lanes.forEach((ln, li) => {
        const yTop = top + li * laneH + 7;
        const yBot = top + (li + 1) * laneH - 7;
        ctx.strokeStyle = faint;
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.moveTo(gutter, yBot + 7); ctx.lineTo(WW - 8, yBot + 7); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = ink;
        ctx.textAlign = "right";
        ctx.fillText(ln.n, gutter - 10, (yTop + yBot) / 2);
        if (!recs.length) return;
        if (ln.kind === "clk" || ln.kind === "bit") {
          ctx.strokeStyle = ink;
          ctx.beginPath();
          recs.forEach((r, i) => {
            const xa = x0 + i * cw;
            if (ln.kind === "clk") {
              if (i === 0) ctx.moveTo(xa, yBot);
              ctx.lineTo(xa, yBot); ctx.lineTo(xa + cw / 2, yBot); ctx.lineTo(xa + cw / 2, yTop); ctx.lineTo(xa + cw, yTop); ctx.lineTo(xa + cw, yBot);
            } else {
              const y = ln.get(r) ? yTop : yBot;
              if (i === 0) ctx.moveTo(xa, y); else ctx.lineTo(xa, y);
              ctx.lineTo(xa + cw, y);
            }
          });
          ctx.stroke();
        } else {
          let i = 0;
          while (i < recs.length) {
            const v = ln.get(recs[i]);
            let j = i;
            while (j + 1 < recs.length && ln.get(recs[j + 1]) === v) j++;
            const xa = x0 + i * cw + 2;
            const xb = x0 + (j + 1) * cw - 2;
            const mid = (yTop + yBot) / 2;
            ctx.beginPath();
            ctx.moveTo(xa + 4, yTop); ctx.lineTo(xb - 4, yTop); ctx.lineTo(xb, mid); ctx.lineTo(xb - 4, yBot); ctx.lineTo(xa + 4, yBot); ctx.lineTo(xa, mid); ctx.closePath();
            ctx.globalAlpha = 0.16; ctx.fillStyle = ln.color; ctx.fill(); ctx.globalAlpha = 1;
            ctx.strokeStyle = ink; ctx.stroke();
            const label = hex(v, Math.ceil(ln.w / 4));
            if (xb - xa > label.length * 6.8 + 8) {
              ctx.fillStyle = ink; ctx.textAlign = "center"; ctx.fillText(label, (xa + xb) / 2, mid);
            }
            i = j + 1;
          }
        }
      });
      if (recs.length) {
        ctx.fillStyle = soft; ctx.textAlign = "center";
        recs.forEach((r, i) => { if (r.cycle % 8 === 0) ctx.fillText(String(r.cycle), x0 + i * cw + cw / 2, LOGICAL_H - 8); });
      }
      ctx.fillStyle = soft; ctx.textAlign = "right";
      ctx.fillText(WW < 600 ? "cycle" : "clock cycle", gutter - 10, LOGICAL_H - 8);
      if (recs.length < NCYC - 8) {
        const msg = "Earlier cycles scroll in from the right as the clock runs";
        const mx = gutter + (x0 - gutter) / 2;
        const mw = msg.length * 6.8 + 28;
        ctx.fillStyle = paper; ctx.globalAlpha = 0.92;
        ctx.fillRect(mx - mw / 2, LOGICAL_H / 2 - 16, mw, 32);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = faint; ctx.lineWidth = 1;
        ctx.strokeRect(mx - mw / 2, LOGICAL_H / 2 - 16, mw, 32);
        ctx.fillStyle = soft; ctx.textAlign = "center";
        ctx.fillText(msg, mx, LOGICAL_H / 2);
      }
      cv.setAttribute("aria-label", `Digital waveforms for the last ${recs.length} clock cycles. uo_out is ${hex(currentOutputs().uoOut, 2)}.`);
    }

    // ---------- floorplan ----------
    function buildFloorplan() {
      const svg = $("floor");
      const m = E.synthesizeGateNetlistMetrics();
      if (!svg) return;
      const by = {};
      m.blocks.forEach((b) => { by[b.name] = b; });
      const core = by.aariv_cordic_core;
      const rest = [by.tt_um_aariv_cordic_alu, by.aariv_mac8, by.aariv_prng_crc];
      const restTotal = rest.reduce((s, b) => s + b.cells, 0);
      const W = m.tileWidthUm;
      const H = m.tileHeightUm;
      const coreW = (W * core.cells) / m.totalCells;
      const colW = W - coreW;
      const place = [{ b: core, x: 0, y: 0, w: coreW, h: H, cls: "fp-core", label: "CORDIC core" }];
      let y = 0;
      const classes = ["fp-top", "fp-mac", "fp-prn"];
      const labels = ["Top level glue", "MAC", "PRBS and CRC"];
      rest.forEach((b, i) => {
        const h = (H * b.cells) / restTotal;
        place.push({ b, x: coreW, y, w: colW, h, cls: classes[i], label: labels[i] });
        y += h;
      });
      let g = `<rect class="fp-tile" x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}"/>`;
      place.forEach((p) => {
        const pct = ((p.b.share * 100)).toFixed(0);
        const labels2 = p.h < 34
          ? `<text class="big" x="${(p.x + 6).toFixed(2)}" y="${(p.y + p.h / 2 + 3).toFixed(2)}">${p.label}, ${p.b.cells} cells</text>`
          : `<text class="big" x="${(p.x + 6).toFixed(2)}" y="${(p.y + 13).toFixed(2)}">${p.label}</text><text x="${(p.x + 6).toFixed(2)}" y="${(p.y + 24).toFixed(2)}">${p.b.cells} cells</text>`;
        g += `<g class="fp-block ${p.cls}" tabindex="0" role="button" data-name="${p.b.name}" aria-label="${p.b.name}, ${p.b.cells} cells, ${pct} percent"><rect x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" width="${p.w.toFixed(2)}" height="${p.h.toFixed(2)}"/>${labels2}</g>`;
      });
      svg.innerHTML = g;
      const rows = $("floor-rows");
      if (rows) {
        rows.innerHTML = m.blocks.map((b) => `<tr><th scope="row"><code>${b.name}</code></th><td class="num">${b.cells}</td><td class="num">${b.flipflops}</td><td class="num">${b.logic}</td></tr>`).join("") +
          `<tr><th scope="row">Total</th><td class="num">${m.totalCells}</td><td class="num">${m.totalFlipFlops}</td><td class="num">${m.totalLogic}</td></tr>`;
      }
      const show = (el) => {
        const b = by[el.getAttribute("data-name")];
        Array.prototype.forEach.call(svg.querySelectorAll(".fp-block"), (n) => n.setAttribute("class", n.getAttribute("class").replace(" active", "")));
        el.setAttribute("class", el.getAttribute("class") + " active");
        text("floor-caption", `${b.name}. ${b.cells} cells, of which ${b.flipflops} flip-flops and ${b.logic} gates. ${(b.share * 100).toFixed(0)} percent of the generic count.`);
      };
      Array.prototype.forEach.call(svg.querySelectorAll(".fp-block"), (el) => {
        el.addEventListener("click", () => show(el));
        el.addEventListener("focus", () => show(el));
        el.addEventListener("mouseenter", () => show(el));
      });
      fill("cells", String(m.totalCells));
    }

    // ---------- hero demo ----------
    function startHero() {
      const angles = [11, -23, 27, -8, 19, 4];
      let ai = 0;
      let fi = 0;
      let pipeline = E.runCordicPipeline({ kind: "rotate", angle: angles[0] });
      const show = () => {
        const frames = pipeline.frames.slice(0, fi + 1);
        drawCircle("h-", frames, 1 / 512, (angles[ai] * Math.PI) / 64);
        text("h-readout", `Rotate by ${(angles[ai] * DEG_PER_UNIT).toFixed(1)} degrees, stage ${Math.min(fi, 8)} of 8`);
      };
      if (reduced) { fi = 8; show(); return; }
      const advance = () => {
        show();
        if (fi < 8) { fi++; win.setTimeout(advance, 260); return; }
        win.setTimeout(() => {
          ai = (ai + 1) % angles.length;
          fi = 0;
          pipeline = E.runCordicPipeline({ kind: "rotate", angle: angles[ai] });
          advance();
        }, 1400);
      };
      advance();
    }

    // ---------- accuracy figures ----------
    function fillAccuracy() {
      const rep = E.rotationErrorReport();
      fill("errcos", rep.maxCosLsb.toFixed(2));
      fill("errsin", rep.maxSinLsb.toFixed(2));
      let mag = 0;
      let ang = 0;
      for (let x = -32; x < 32; x++) {
        for (let y = -32; y < 32; y++) {
          if (x === 0 && y === 0) continue;
          const r = E.runCordicPipeline({ kind: "vector", xin: x, yin: y });
          const ref = E.vectorReference(x, y);
          mag = Math.max(mag, Math.abs(((r.final.x >> 3) & 0xff) - ref.mag));
          if (Math.hypot(x, y) >= 8) {
            let e = Math.abs((r.final.z >> 3) - ref.angleBam);
            e = Math.min(e, 256 - e);
            ang = Math.max(ang, e);
          }
        }
      }
      fill("errmag", mag.toFixed(2));
      fill("errang", ang.toFixed(2));
      fill("cosim", E.VERIFIED_COSIM_CYCLES.toLocaleString("en-US"));
    }

    // ---------- render and wiring ----------
    function renderAll() {
      renderOutputs();
      renderCircle();
      drawWave();
      renderPinout();
      decodeText();
    }

    Array.prototype.forEach.call(doc.querySelectorAll(".dip[data-bus]"), (el) => {
      el.addEventListener("click", () => toggleBit(el.getAttribute("data-bus"), Number(el.getAttribute("data-bit"))));
    });
    const rstDip = $("dip-rstn");
    if (rstDip) rstDip.addEventListener("click", () => { S.rstN ^= 1; syncSwitches(); renderOutputs(); });
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
    on("btn-step", () => { clockOnce(); });
    on("btn-run", () => { S.running = !S.running; scheduleTick(); });
    on("btn-start", () => {
      const base = S.uio & ~1;
      enqueue([{ uio: base | 1 }, { uio: base }]);
    });
    on("btn-reset", () => { S.queue = []; enqueue([{ rst: 0 }, { rst: 0 }, { rst: 1 }]); });
    const speed = $("speed");
    if (speed) speed.addEventListener("input", () => { text("speed-out", `${speed.value} Hz`); scheduleTick(); });
    Array.prototype.forEach.call(doc.querySelectorAll("[data-preset]"), (el) => {
      el.addEventListener("click", () => runPreset(el.getAttribute("data-preset")));
    });
    on("btn-vcd", () => {
      const a = $("btn-vcd");
      if (!a || !win.Blob || !win.URL || !win.URL.createObjectURL) return;
      const vcd = E.generateVcdWaveform(S.history);
      a.setAttribute("href", win.URL.createObjectURL(new win.Blob([vcd], { type: "text/plain" })));
    });

    if (win.addEventListener) win.addEventListener("resize", () => drawWave());
    buildPinout();
    buildFloorplan();
    syncSwitches();
    describePins();
    renderAll();
    S.rstN = 0;
    clockOnce();
    clockOnce();
    S.rstN = 1;
    for (let i = 0; i < 6; i++) clockOnce();
    syncSwitches();
    S.cycles = S.chip.cycle;
    renderAll();
    startHero();
    fillAccuracy();

    return S;
  }

  return { init };
});
