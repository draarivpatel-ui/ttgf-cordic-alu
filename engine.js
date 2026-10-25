/*
 * engine.js: bit-exact, cycle-accurate JavaScript twin of src/project.v.
 *
 * Every register in the Verilog has a field in the chip state here, and tick()
 * applies the same clock-edge transfers. tests/cosim.test.js replays hundreds of
 * thousands of random clock cycles through Icarus Verilog and compares every
 * output and internal register against this file.
 *
 * Works in the browser (window.CordicEngine) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CordicEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const OP = { ROTATE: 0, VECTOR: 1, MAC: 2, PRNG: 3 };
  const VIEW = { ROTATE: 0, VECTOR: 1, MAC: 2, LFSR: 3, CRC: 4 };

  // atan(2^-i) in units of pi/64 with 4 fractional bits, rounded to nearest.
  const ATAN_Q = Object.freeze([256, 151, 80, 41, 20, 10, 5, 3]);
  const ROTATE_X0 = 311; // round(512 / K), K = prod sqrt(1 + 2^-2i) for i = 0..7
  const CORDIC_GAIN = 1.646743506596901;
  const STAGES = 8;
  // Clock cycles replayed through Icarus Verilog by tests/cosim.test.js (two seeds). The test asserts this.
  const VERIFIED_COSIM_CYCLES = 320028;

  // Copied from docs/synth-stats.json. tests/engine.test.js checks they match.
  const GATE_STATS = Object.freeze({
    tool: "yosys 0.70",
    mapping: "generic gates + flip-flops, not GF180MCU",
    total_cells: 835,
    total_flipflops: 75,
    total_logic: 760,
    modules: Object.freeze({
      aariv_cordic_core: Object.freeze({ cells: 454, flipflops: 39, logic: 415 }),
      aariv_mac8: Object.freeze({ cells: 92, flipflops: 9, logic: 83 }),
      aariv_prng_crc: Object.freeze({ cells: 49, flipflops: 16, logic: 33 }),
      tt_um_aariv_cordic_alu: Object.freeze({ cells: 240, flipflops: 11, logic: 229 }),
    }),
  });

  const s6 = (v) => (v << 26) >> 26;
  const s8 = (v) => (v << 24) >> 24;
  const s11 = (v) => (v << 21) >> 21;
  const s12 = (v) => (v << 20) >> 20;
  const u8 = (v) => v & 0xff;

  function sat8(v) {
    if (v > 127) return 127;
    if (v < -128) return -128;
    return v;
  }

  function lfsrNext(l) {
    return u8((l << 1) ^ (l & 0x80 ? 0x71 : 0x00));
  }

  function crc8Byte(c, d) {
    let t = u8(c ^ d);
    for (let k = 0; k < 8; k++) t = u8(t & 0x80 ? (t << 1) ^ 0x07 : t << 1);
    return t;
  }

  function createChip() {
    const c = {};
    resetChip(c);
    return c;
  }

  function resetChip(c) {
    c.x = 0;
    c.y = 0;
    c.z = 0;
    c.iter = 0;
    c.busy = 0;
    c.vecMode = 0;
    c.acc = 0;
    c.macSat = 0;
    c.lfsr = 0x01;
    c.crc = 0x00;
    c.startQ = 0;
    c.view = VIEW.MAC;
    c.xin = 0;
    c.cycle = c.cycle || 0;
    return c;
  }

  function decodePins(ui, uio) {
    return {
      op: (ui >> 6) & 3,
      a: s6(ui & 0x3f),
      aRaw: ui & 0x3f,
      startPin: uio & 1,
      mode: (uio >> 1) & 1,
      rsel: (uio >> 2) & 1,
      gain3: (uio >> 3) & 1,
    };
  }

  /** Apply one rising clock edge. Mutates the chip, returns the new outputs. */
  function tick(c, uiIn, uioIn, rstN) {
    const p = decodePins(uiIn & 0xff, uioIn & 0xff);
    const start = p.startPin && !c.startQ ? 1 : 0;
    const busy = c.busy;
    const idle = !busy;
    const opRot = p.op === OP.ROTATE;
    const opVec = p.op === OP.VECTOR;
    const opMac = p.op === OP.MAC;
    const opPrn = p.op === OP.PRNG;

    // Vectoring set-up (combinational in the Verilog, uses pre-edge xin).
    const xa = s11(c.xin << 3);
    const ya = s11(p.a << 3);
    const vFold = c.xin < 0 ? 1 : 0;
    const vYpos = p.a >= 0 ? 1 : 0;
    const vx0 = !vFold ? xa : vYpos ? ya : s11(-ya);
    const vy0 = !vFold ? ya : vYpos ? s11(-xa) : xa;
    const vz0 = !vFold ? 0 : vYpos ? 512 : -512;

    const goRot = start && idle && opRot;
    const goVec = start && idle && opVec && p.mode;
    const ldVecX = start && idle && opVec && !p.mode;
    const doAcc = start && idle && opMac && !p.mode;
    const doClr = start && idle && opMac && p.mode;
    const prnFree = opPrn && !p.mode && idle;

    // Pre-edge values the next-state logic reads.
    const n = {};

    // CORDIC core
    {
      const xs = c.x >> c.iter;
      const ys = c.y >> c.iter;
      const dpos = c.vecMode ? (c.y < 0 ? 1 : 0) : c.z < 0 ? 0 : 1;
      const at = ATAN_Q[c.iter];
      if (!rstN) {
        n.x = 0; n.y = 0; n.z = 0; n.iter = 0; n.busy = 0; n.vecMode = 0;
      } else if (busy) {
        n.x = s11(dpos ? c.x - ys : c.x + ys);
        n.y = s11(dpos ? c.y + xs : c.y - xs);
        n.z = s12(dpos ? c.z - at : c.z + at);
        n.iter = (c.iter + 1) & 7;
        n.busy = c.iter === 7 ? 0 : 1;
        n.vecMode = c.vecMode;
      } else if (goRot || goVec) {
        n.x = goVec ? vx0 : ROTATE_X0;
        n.y = goVec ? vy0 : 0;
        n.z = goVec ? vz0 : s12(p.a << 4);
        n.iter = 0;
        n.busy = 1;
        n.vecMode = goVec ? 1 : 0;
      } else {
        n.x = c.x; n.y = c.y; n.z = c.z; n.iter = c.iter; n.busy = c.busy; n.vecMode = c.vecMode;
      }
    }

    // MAC
    {
      const prod = s8(p.gain3 ? p.a + (p.a << 1) : p.a);
      const sum = c.acc + prod;
      const over = sum > 127;
      const under = sum < -128;
      if (!rstN || doClr) {
        n.acc = 0; n.macSat = 0;
      } else if (doAcc) {
        n.acc = over ? 127 : under ? -128 : s8(sum);
        n.macSat = over || under ? 1 : 0;
      } else {
        n.acc = c.acc; n.macSat = c.macSat;
      }
    }

    // LFSR + CRC
    {
      const seed = start && prnFree;
      const step = prnFree && !start;
      const crcFeed = start && idle && opPrn && p.mode && !p.rsel;
      const crcClear = start && idle && opPrn && p.mode && p.rsel;
      if (!rstN) {
        n.lfsr = 0x01; n.crc = 0x00;
      } else {
        n.lfsr = seed ? 0x40 | p.aRaw : step ? lfsrNext(c.lfsr) : c.lfsr;
        n.crc = crcClear ? 0 : crcFeed ? crc8Byte(c.crc, p.aRaw) : c.crc;
      }
    }

    // Top-level registers
    if (!rstN) {
      n.startQ = 0; n.view = VIEW.MAC; n.xin = 0;
    } else {
      n.startQ = p.startPin;
      n.xin = ldVecX ? p.a : c.xin;
      let v = c.view;
      if (goRot) v = VIEW.ROTATE;
      else if (goVec) v = VIEW.VECTOR;
      else if (start && idle && opMac) v = VIEW.MAC;
      else if (prnFree) v = VIEW.LFSR;
      else if (start && idle && opPrn && p.mode) v = VIEW.CRC;
      n.view = v;
    }

    Object.assign(c, n);
    c.cycle = (c.cycle || 0) + 1;
    return outputs(c, uioIn);
  }

  /** Combinational outputs for the current state and uio_in pins. */
  function outputs(c, uioIn) {
    const rsel = (uioIn >> 2) & 1;
    const disp9 = (rsel ? c.y : c.x) >> 2;
    const rotOvf = disp9 > 127 || disp9 < -128;
    let out;
    switch (c.view) {
      case VIEW.ROTATE: out = u8(sat8(disp9)); break;
      case VIEW.VECTOR: out = rsel ? (c.z >> 3) & 0xff : (c.x >> 3) & 0xff; break;
      case VIEW.MAC: out = u8(c.acc); break;
      case VIEW.LFSR: out = c.lfsr; break;
      default: out = c.crc;
    }
    const ovf = c.view === VIEW.ROTATE ? (rotOvf ? 1 : 0) : c.view === VIEW.MAC ? c.macSat : 0;
    const zero = out === 0 ? 1 : 0;
    const sign = (out >> 7) & 1;
    const uioOut = (sign << 7) | (ovf << 6) | (zero << 5) | (c.busy << 4);
    return { uoOut: out, uioOut, uioOe: 0xf0, flags: { busy: c.busy, zero, overflow: ovf, sign } };
  }

  /** One full-cycle record for waveform and VCD use. */
  function stepClock(c, uiIn, uioIn, rstN) {
    const before = { ui: uiIn & 0xff, uio: uioIn & 0xff, rstN: rstN ? 1 : 0 };
    const o = tick(c, uiIn, uioIn, rstN ? 1 : 0);
    return {
      cycle: c.cycle,
      uiIn: before.ui,
      uioIn: before.uio,
      rstN: before.rstN,
      uoOut: o.uoOut,
      uioOut: o.uioOut,
      x: c.x & 0x7ff,
      y: c.y & 0x7ff,
      z: c.z & 0xfff,
      iter: c.iter,
      busy: c.busy,
      view: c.view,
      acc: u8(c.acc),
      lfsr: c.lfsr,
      crc: c.crc,
      xs: c.x,
      ys: c.y,
      zs: c.z,
    };
  }

  function resetSequence(c, cycles) {
    const out = [];
    for (let i = 0; i < (cycles || 2); i++) out.push(stepClock(c, 0, 0, 0));
    return out;
  }

  /**
   * Drive a fresh chip through one CORDIC operation and return every micro-rotation.
   * kind "rotate": angle (signed 6-bit, units of pi/64).
   * kind "vector": xin and yin (signed 6-bit each).
   */
  function runCordicPipeline(opts) {
    const c = createChip();
    resetSequence(c, 2);
    const trace = [];
    const frames = [];
    const push = (r) => trace.push(r);
    let uio = 0;
    if (opts.kind === "vector") {
      push(stepClock(c, (OP.VECTOR << 6) | (opts.xin & 0x3f), 0, 1));
      push(stepClock(c, (OP.VECTOR << 6) | (opts.xin & 0x3f), 1, 1)); // START, load x
      push(stepClock(c, (OP.VECTOR << 6) | (opts.yin & 0x3f), 2, 1)); // START low, MODE=1
      uio = 3;
      push(stepClock(c, (OP.VECTOR << 6) | (opts.yin & 0x3f), uio, 1)); // START rising, go
    } else {
      const ui = (OP.ROTATE << 6) | (opts.angle & 0x3f);
      push(stepClock(c, ui, 0, 1));
      push(stepClock(c, ui, 1, 1));
      uio = 0;
    }
    const startSnap = { x: c.x, y: c.y, z: c.z };
    frames.push({ stage: -1, x: startSnap.x, y: startSnap.y, z: startSnap.z, d: 0 });
    const ui = opts.kind === "vector" ? (OP.VECTOR << 6) | (opts.yin & 0x3f) : (OP.ROTATE << 6) | (opts.angle & 0x3f);
    let guard = 0;
    while (c.busy && guard++ < 16) {
      const dpos = c.vecMode ? (c.y < 0 ? 1 : 0) : c.z < 0 ? 0 : 1;
      const stage = c.iter;
      const r = stepClock(c, ui, uio & ~1, 1);
      push(r);
      frames.push({ stage, x: c.x, y: c.y, z: c.z, d: dpos ? 1 : -1 });
    }
    return { trace, frames, final: { x: c.x, y: c.y, z: c.z }, chip: c, uio };
  }

  /** Floating-point references used for error reporting. */
  function rotateReference(angleUnits) {
    const rad = (angleUnits * Math.PI) / 64;
    return { cos: Math.cos(rad), sin: Math.sin(rad), rad };
  }

  function vectorReference(x, y) {
    return { mag: CORDIC_GAIN * Math.hypot(x, y), angleBam: (Math.atan2(y, x) * 128) / Math.PI };
  }

  /** Run rotation for every one of the 64 angles and measure the error against Math.cos/sin. */
  function rotationErrorReport() {
    let maxCos = 0;
    let maxSin = 0;
    let worstAngle = 0;
    for (let a = -32; a < 32; a++) {
      const r = runCordicPipeline({ kind: "rotate", angle: a });
      const ref = rotateReference(a);
      const cosQ = sat8(r.final.x >> 2);
      const sinQ = sat8(r.final.y >> 2);
      const ec = Math.abs(cosQ - Math.min(ref.cos * 128, 127));
      const es = Math.abs(sinQ - Math.min(ref.sin * 128, 127));
      if (ec > maxCos) { maxCos = ec; worstAngle = a; }
      if (es > maxSin) maxSin = es;
    }
    return { maxCosLsb: maxCos, maxSinLsb: maxSin, worstAngle };
  }

  function synthesizeGateNetlistMetrics() {
    const mods = GATE_STATS.modules;
    const total = GATE_STATS.total_cells;
    const blocks = Object.keys(mods).map((name) => ({
      name,
      cells: mods[name].cells,
      flipflops: mods[name].flipflops,
      logic: mods[name].logic,
      share: mods[name].cells / total,
    }));
    return {
      tool: GATE_STATS.tool,
      mapping: GATE_STATS.mapping,
      totalCells: total,
      totalFlipFlops: GATE_STATS.total_flipflops,
      totalLogic: GATE_STATS.total_logic,
      blocks,
      tileWidthUm: 340,
      tileHeightUm: 160,
      tileAreaUm2: 340 * 160,
    };
  }

  const toBin = (v, w) => (v & ((1 << w) - 1)).toString(2).padStart(w, "0");

  /** IEEE 1364 value change dump for a list of stepClock() records. */
  function generateVcdWaveform(trace, opts) {
    const period = (opts && opts.periodNs) || 10;
    const signals = [
      ["clk", 1, "!"], ["rst_n", 1, "\""], ["ui_in", 8, "#"], ["uio_in", 8, "$"],
      ["uo_out", 8, "%"], ["uio_out", 8, "&"], ["x_reg", 11, "'"], ["y_reg", 11, "("],
      ["z_reg", 12, ")"], ["iter", 3, "*"], ["busy", 1, "+"],
    ];
    const lines = [
      "$date generated by engine.js $end",
      "$version tt_um_aariv_cordic_alu JavaScript twin $end",
      "$timescale 1 ns $end",
      "$scope module tb $end",
    ];
    signals.forEach(([n, w, id]) => lines.push(`$var wire ${w} ${id} ${n}${w > 1 ? ` [${w - 1}:0]` : ""} $end`));
    lines.push("$upscope $end", "$enddefinitions $end");
    const last = {};
    const emit = (id, w, v) => {
      if (last[id] === v) return;
      last[id] = v;
      lines.push(w === 1 ? `${v}${id}` : `b${toBin(v, w)} ${id}`);
    };
    trace.forEach((r, k) => {
      const t0 = k * period;
      lines.push(`#${t0}`);
      emit("!", 1, 0);
      emit("\"", 1, r.rstN);
      emit("#", 8, r.uiIn);
      emit("$", 8, r.uioIn);
      lines.push(`#${t0 + period / 2}`);
      emit("!", 1, 1);
      emit("%", 8, r.uoOut);
      emit("&", 8, r.uioOut);
      emit("'", 11, r.x);
      emit("(", 11, r.y);
      emit(")", 12, r.z);
      emit("*", 3, r.iter);
      emit("+", 1, r.busy);
    });
    lines.push(`#${trace.length * period}`);
    return lines.join("\n") + "\n";
  }

  return {
    OP, VIEW, ATAN_Q, ROTATE_X0, CORDIC_GAIN, STAGES, GATE_STATS, VERIFIED_COSIM_CYCLES,
    createChip, resetChip, tick, outputs, stepClock, resetSequence, runCordicPipeline,
    rotateReference, vectorReference, rotationErrorReport, synthesizeGateNetlistMetrics,
    generateVcdWaveform, lfsrNext, crc8Byte, sat8, decodePins,
  };
});
