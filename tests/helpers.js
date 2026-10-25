"use strict";
// Shared helpers for the co-simulation test: seeded stimulus and trace formatting.
const E = require("../engine.js");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns an array of [rstN, uio, ui] cycles: directed sweeps first, then seeded random. */
function buildStimulus(randomCycles, seed) {
  const rnd = mulberry32(seed);
  const cyc = [];
  const add = (rstN, uio, ui) => cyc.push([rstN, uio & 0xff, ui & 0xff]);
  const hold = (n, uio, ui) => { for (let i = 0; i < n; i++) add(1, uio, ui); };
  add(0, 0, 0); add(0, 0, 0); add(0, 0, 0);

  // Directed: every rotation angle, read cos then sin.
  for (let a = 0; a < 64; a++) {
    add(1, 0, a); add(1, 1, a); hold(11, 0, a); hold(2, 4, a);
  }
  // Directed: vectoring over a grid that includes every quadrant and the axes.
  for (let x = 0; x < 64; x += 3) {
    for (let y = 0; y < 64; y += 3) {
      const ui = 0x40;
      add(1, 0, ui | x); add(1, 1, ui | x); add(1, 0, ui | x);
      add(1, 2, ui | y); add(1, 3, ui | y); hold(10, 2, ui | y); hold(2, 6, ui | y);
    }
  }
  // Directed: MAC saturation both ways, gain 1 and 3, clear.
  add(1, 3, 0x80); add(1, 2, 0x80);
  for (let i = 0; i < 12; i++) { add(1, 8 | 1, 0x80 | 31); add(1, 8, 0x80 | 31); }
  for (let i = 0; i < 12; i++) { add(1, 8 | 1, 0x80 | 32); add(1, 8, 0x80 | 32); }
  for (let i = 0; i < 20; i++) { add(1, 1, 0x80 | (i * 7)); add(1, 0, 0x80 | (i * 7)); }
  // Directed: LFSR seed and free-run for more than one full period, then CRC.
  add(1, 1, 0xc0 | 5); add(1, 0, 0xc0 | 5); hold(600, 0, 0xc0 | 5);
  add(1, 6, 0xc0); add(1, 7, 0xc0); add(1, 6, 0xc0);
  for (let i = 0; i < 64; i++) { add(1, 2, 0xc0 | i); add(1, 3, 0xc0 | i); }
  // Random, with occasional resets.
  let ui = 0, uio = 0, rstLow = 0;
  for (let i = 0; i < randomCycles; i++) {
    if (rnd() < 0.3) ui = Math.floor(rnd() * 256);
    if (rnd() < 0.5) uio = (uio & 0xf0) | Math.floor(rnd() * 16);
    if (rnd() < 0.002) rstLow = 1 + Math.floor(rnd() * 2);
    const r = rstLow > 0 ? 0 : 1;
    if (rstLow > 0) rstLow--;
    add(r, uio, ui);
  }
  return cyc;
}

const hex = (v, w) => (v >>> 0).toString(16).padStart(w, "0");

function formatRecord(r, chip) {
  return [
    hex(r.uoOut, 2), hex(r.uioOut, 2), hex(r.x, 3), hex(r.y, 3), hex(r.z, 3),
    r.iter.toString(16), r.busy.toString(16), r.view.toString(16),
    hex(r.acc, 2), hex(r.lfsr, 2), hex(r.crc, 2), chip.vecMode.toString(16),
  ].join(" ");
}

function stimulusToHex(cycles) {
  return cycles.map(([rstN, uio, ui]) => hex((rstN << 16) | (uio << 8) | ui, 5)).join("\n") + "\n";
}

function jsTrace(cycles) {
  const chip = E.createChip();
  return cycles.map(([rstN, uio, ui]) => formatRecord(E.stepClock(chip, ui, uio, rstN), chip));
}

module.exports = { mulberry32, buildStimulus, stimulusToHex, jsTrace, hex };
