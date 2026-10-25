"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");

const root = path.resolve(__dirname, "..");
const ROT = E.OP.ROTATE << 6;
const VEC = E.OP.VECTOR << 6;
const MAC = E.OP.MAC << 6;
const PRN = E.OP.PRNG << 6;

function freshChip() {
  const c = E.createChip();
  E.resetSequence(c, 2);
  return c;
}

/** Pulse START once with the given pins, then release it. Returns the record after release. */
function pulse(c, ui, uio) {
  E.stepClock(c, ui, uio & ~1, 1);
  E.stepClock(c, ui, uio | 1, 1);
  return E.stepClock(c, ui, uio & ~1, 1);
}

function rotate(angle) {
  const c = freshChip();
  const ui = ROT | (angle & 0x3f);
  E.stepClock(c, ui, 0, 1);
  E.stepClock(c, ui, 1, 1); // rising START loads the registers; BUSY goes high after this edge
  let n = 0;
  while (c.busy && n < 20) { E.stepClock(c, ROT | (angle & 0x3f), 0, 1); n++; }
  return { c, cycles: n };
}

function rotateOut(angle) {
  const { c } = rotate(angle);
  const ui = ROT | (angle & 0x3f);
  const cos = E.outputs(c, 0);
  const sin = E.outputs(c, 4);
  return { cos: (cos.uoOut << 24) >> 24, sin: (sin.uoOut << 24) >> 24, cosO: cos, sinO: sin, ui };
}

function vector(x, y) {
  const r = E.runCordicPipeline({ kind: "vector", xin: x, yin: y });
  const mag = E.outputs(r.chip, 0).uoOut;
  const ang = (E.outputs(r.chip, 4).uoOut << 24) >> 24;
  return { mag, ang, r };
}

// ---- constants ----------------------------------------------------------
for (let i = 0; i < 8; i++) {
  test(`atan table entry ${i} is round(atan(2^-${i}) * 1024 / pi)`, () => {
    assert.equal(E.ATAN_Q[i], Math.round((Math.atan(2 ** -i) * 1024) / Math.PI));
  });
}

test("rotation start value is round(512 / K)", () => {
  assert.equal(E.ROTATE_X0, Math.round(512 / E.CORDIC_GAIN));
});

test("CORDIC gain is the product of sqrt(1 + 2^-2i) over 8 stages", () => {
  let k = 1;
  for (let i = 0; i < 8; i++) k *= Math.sqrt(1 + 2 ** (-2 * i));
  assert.ok(Math.abs(k - E.CORDIC_GAIN) < 1e-12);
});

test("the atan table is strictly decreasing", () => {
  for (let i = 1; i < 8; i++) assert.ok(E.ATAN_Q[i] < E.ATAN_Q[i - 1]);
});

// ---- helpers ------------------------------------------------------------
test("sat8 clamps both ways and passes in-range values", () => {
  assert.equal(E.sat8(300), 127);
  assert.equal(E.sat8(-300), -128);
  assert.equal(E.sat8(-5), -5);
  assert.equal(E.sat8(127), 127);
  assert.equal(E.sat8(-128), -128);
});

test("CRC-8 (poly 0x07) of the ASCII string 123456789 is the standard check value 0xF4", () => {
  let c = 0;
  for (const ch of "123456789") c = E.crc8Byte(c, ch.charCodeAt(0));
  assert.equal(c, 0xf4);
});

test("CRC-8 of a zero byte from zero stays zero", () => {
  assert.equal(E.crc8Byte(0, 0), 0);
});

test("LFSR never reaches zero and has period 255 from every nonzero seed", () => {
  for (let seed = 1; seed < 256; seed++) {
    let l = seed;
    let period = 0;
    do {
      l = E.lfsrNext(l);
      assert.notEqual(l, 0);
      period++;
    } while (l !== seed && period < 300);
    assert.equal(period, 255, `seed ${seed}`);
  }
});

test("LFSR visits 255 distinct states", () => {
  const seen = new Set();
  let l = 1;
  for (let i = 0; i < 255; i++) { seen.add(l); l = E.lfsrNext(l); }
  assert.equal(seen.size, 255);
});

test("decodePins splits the opcode, signed operand and control bits", () => {
  const p = E.decodePins(0b10_100001, 0b1110);
  assert.equal(p.op, 2);
  assert.equal(p.a, -31);
  assert.equal(p.startPin, 0);
  assert.equal(p.mode, 1);
  assert.equal(p.rsel, 1);
  assert.equal(p.gain3, 1);
});

// ---- reset and pins -----------------------------------------------------
test("after reset the output is zero and the ZERO flag is high", () => {
  const c = freshChip();
  const o = E.outputs(c, 0);
  assert.equal(o.uoOut, 0);
  assert.equal(o.uioOut, 0x20);
  assert.equal(o.uioOe, 0xf0);
});

test("uio_oe makes the top nibble outputs and the low nibble inputs", () => {
  assert.equal(E.outputs(freshChip(), 0).uioOe, 0xf0);
});

test("reset during a rotation clears BUSY and the registers", () => {
  const c = freshChip();
  pulse(c, ROT | 5, 0);
  assert.equal(c.busy, 1);
  E.stepClock(c, 0, 0, 0);
  assert.equal(c.busy, 0);
  assert.equal(c.x, 0);
  assert.equal(c.z, 0);
  assert.equal(c.view, E.VIEW.MAC);
});

// ---- rotation -----------------------------------------------------------
test("a rotation takes exactly 8 clock cycles of BUSY", () => {
  assert.equal(rotate(7).cycles, 8);
});

test("BUSY is high for the whole rotation and low afterwards", () => {
  const c = freshChip();
  const ui = ROT | 3;
  E.stepClock(c, ui, 0, 1);
  const first = E.stepClock(c, ui, 1, 1);
  assert.equal((first.uioOut >> 4) & 1, 1);
  let seen = 0;
  while (c.busy) { E.stepClock(c, ui, 0, 1); seen++; }
  assert.equal(seen, 8);
  assert.equal((E.outputs(c, 0).uioOut >> 4) & 1, 0);
});

test("the iteration counter walks 0 to 7 and wraps", () => {
  const r = E.runCordicPipeline({ kind: "rotate", angle: 9 });
  assert.deepEqual(r.frames.slice(1).map((f) => f.stage), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("rotation by 0 gives cos saturated to +127 with OVERFLOW set and sin near 0", () => {
  const r = rotateOut(0);
  assert.equal(r.cos, 127);
  assert.equal((r.cosO.uioOut >> 6) & 1, 1);
  assert.ok(Math.abs(r.sin) <= 2);
});

test("rotation by -32 (minus 90 degrees) gives cos near 0 and sin saturated to -128", () => {
  const r = rotateOut(-32);
  assert.ok(Math.abs(r.cos) <= 2);
  assert.equal(r.sin, -128);
  assert.equal((r.sinO.uioOut >> 6) & 1, 0); // -128 is representable, so no overflow
});

test("rotation by 16 (45 degrees) gives equal cos and sin within 2 LSB", () => {
  const r = rotateOut(16);
  assert.ok(Math.abs(r.cos - r.sin) <= 2);
  assert.ok(Math.abs(r.cos - 90.5) <= 2);
});

test("rotation by 10 matches the hand value cos 0.8819, sin 0.4714", () => {
  const r = rotateOut(10);
  assert.ok(Math.abs(r.cos - 0.8819 * 128) <= 1.8);
  assert.ok(Math.abs(r.sin - 0.4714 * 128) <= 1.5);
});

test("cos is even and sin is odd up to 2 LSB for every angle", () => {
  for (let a = 1; a <= 31; a++) {
    const p = rotateOut(a);
    const n = rotateOut(-a);
    assert.ok(Math.abs(p.cos - n.cos) <= 2, `cos ${a}`);
    assert.ok(Math.abs(p.sin + n.sin) <= 2, `sin ${a}`);
  }
});

test("the full 64-angle sweep stays within 1.8 LSB (cos) and 1.5 LSB (sin) of Math.cos and Math.sin", () => {
  const rep = E.rotationErrorReport();
  assert.ok(rep.maxCosLsb <= 1.8, `cos ${rep.maxCosLsb}`);
  assert.ok(rep.maxSinLsb <= 1.5, `sin ${rep.maxSinLsb}`);
});

test("cos squared plus sin squared stays within 3 percent of 1 for every angle", () => {
  for (let a = -32; a < 32; a++) {
    const r = rotateOut(a);
    const m = (r.cos / 128) ** 2 + (r.sin / 128) ** 2;
    assert.ok(Math.abs(m - 1) < 0.03, `angle ${a}: ${m}`);
  }
});

test("z converges toward zero in rotation mode", () => {
  const r = E.runCordicPipeline({ kind: "rotate", angle: 23 });
  assert.ok(Math.abs(r.final.z) <= 4, `z ${r.final.z}`);
});

test("rotation ignores a second START while BUSY", () => {
  const c = freshChip();
  const ui = ROT | 12;
  pulse(c, ui, 0);
  const x1 = c.x;
  E.stepClock(c, ROT | 20, 0, 1);
  E.stepClock(c, ROT | 20, 1, 1);
  assert.equal(c.busy, 1);
  assert.notEqual(c.x, 311);
  assert.ok(x1 !== undefined);
});

// ---- vectoring ----------------------------------------------------------
test("vectoring (20, 0) gives magnitude 32 and angle 0", () => {
  const v = vector(20, 0);
  assert.ok(Math.abs(v.mag - 32.93) <= 1.1);
  assert.ok(Math.abs(v.ang) <= 1);
});

test("vectoring (0, 20) gives angle 64, a quarter of the 128-count half turn", () => {
  const v = vector(0, 20);
  assert.ok(Math.abs(v.ang - 64) <= 1.7);
});

test("vectoring (-20, 0) gives an angle of plus or minus 128 (the same half turn)", () => {
  const v = vector(-20, 0);
  const wrapped = Math.abs(v.ang);
  assert.ok(wrapped >= 126, `angle ${v.ang}`);
});

test("vectoring (10, -10) gives angle -32", () => {
  const v = vector(10, -10);
  assert.ok(Math.abs(v.ang + 32) <= 1.7);
});

test("vectoring (-10, -10) gives angle -96", () => {
  const v = vector(-10, -10);
  assert.ok(Math.abs(v.ang + 96) <= 1.7);
});

test("vectoring (-10, 10) gives angle 96", () => {
  const v = vector(-10, 10);
  assert.ok(Math.abs(v.ang - 96) <= 1.7);
});

test("vectoring magnitude is within 1.1 of 1.6467 * hypot for every input", () => {
  let worst = 0;
  for (let x = -32; x < 32; x++) {
    for (let y = -32; y < 32; y++) {
      if (x === 0 && y === 0) continue;
      const v = vector(x, y);
      worst = Math.max(worst, Math.abs(v.mag - E.vectorReference(x, y).mag));
    }
  }
  assert.ok(worst <= 1.1, `worst ${worst}`);
});

test("vectoring angle error is at most 1.2 counts for vectors of length 8 or more, and 6.1 below 4", () => {
  const limit = { big: 0, mid: 0, small: 0 };
  for (let x = -32; x < 32; x++) {
    for (let y = -32; y < 32; y++) {
      if (x === 0 && y === 0) continue;
      const v = vector(x, y);
      let err = Math.abs(v.ang - E.vectorReference(x, y).angleBam);
      err = Math.min(err, 256 - err);
      const h = Math.hypot(x, y);
      const k = h >= 8 ? "big" : h >= 4 ? "mid" : "small";
      limit[k] = Math.max(limit[k], err);
    }
  }
  assert.ok(limit.big <= 1.2, `big ${limit.big}`);
  assert.ok(limit.mid <= 1.7, `mid ${limit.mid}`);
  assert.ok(limit.small <= 6.1, `small ${limit.small}`);
});

test("the zero vector terminates (BUSY falls) even though its angle is undefined", () => {
  const r = E.runCordicPipeline({ kind: "vector", xin: 0, yin: 0 });
  assert.equal(r.chip.busy, 0);
});

test("loading the vectoring X operand does not start a computation", () => {
  const c = freshChip();
  pulse(c, VEC | 9, 0);
  assert.equal(c.busy, 0);
  assert.equal(c.xin, 9);
});

// ---- MAC ----------------------------------------------------------------
test("MAC accumulates a signed operand", () => {
  const c = freshChip();
  pulse(c, MAC | 5, 0);
  pulse(c, MAC | 5, 0);
  pulse(c, MAC | (-3 & 0x3f), 0);
  assert.equal(E.outputs(c, 0).uoOut, 7);
});

test("MAC gain 3 multiplies the operand by three with a shift and an add", () => {
  const c = freshChip();
  pulse(c, MAC | 7, 8);
  assert.equal(E.outputs(c, 0).uoOut, 21);
  pulse(c, MAC | (-4 & 0x3f), 8);
  assert.equal(E.outputs(c, 0).uoOut, 9);
});

test("MAC saturates at +127 and raises OVERFLOW", () => {
  const c = freshChip();
  let o;
  for (let i = 0; i < 8; i++) { pulse(c, MAC | 31, 8); o = E.outputs(c, 0); }
  assert.equal(o.uoOut, 127);
  assert.equal(o.flags.overflow, 1);
});

test("MAC saturates at -128 and raises OVERFLOW and SIGN", () => {
  const c = freshChip();
  let o;
  for (let i = 0; i < 8; i++) { pulse(c, MAC | 32, 8); o = E.outputs(c, 0); }
  assert.equal(o.uoOut, 0x80);
  assert.equal(o.flags.overflow, 1);
  assert.equal(o.flags.sign, 1);
});

test("OVERFLOW clears on the next accumulate that does not saturate", () => {
  const c = freshChip();
  for (let i = 0; i < 6; i++) pulse(c, MAC | 31, 8);
  assert.equal(E.outputs(c, 0).flags.overflow, 1);
  pulse(c, MAC | (-31 & 0x3f), 0);
  assert.equal(E.outputs(c, 0).flags.overflow, 0);
});

test("MAC mode bit clears the accumulator and the ZERO flag rises", () => {
  const c = freshChip();
  pulse(c, MAC | 9, 0);
  pulse(c, MAC, 2);
  const o = E.outputs(c, 0);
  assert.equal(o.uoOut, 0);
  assert.equal(o.flags.zero, 1);
});

test("a held START accumulates only once (rising edge detect)", () => {
  const c = freshChip();
  for (let i = 0; i < 5; i++) E.stepClock(c, MAC | 4, 1, 1);
  assert.equal(E.outputs(c, 1).uoOut, 4);
});

test("MAC does not accumulate while the CORDIC core is BUSY", () => {
  const c = freshChip();
  pulse(c, ROT | 4, 0);
  assert.equal(c.busy, 1);
  E.stepClock(c, MAC | 9, 0, 1);
  E.stepClock(c, MAC | 9, 1, 1);
  assert.equal(c.acc, 0);
});

// ---- PRNG and CRC -------------------------------------------------------
test("seeding the LFSR loads 01 followed by the six operand bits", () => {
  const c = freshChip();
  E.stepClock(c, PRN | 0x15, 0, 1);
  E.stepClock(c, PRN | 0x15, 1, 1);
  assert.equal(c.lfsr, 0x55);
});

test("with opcode 3 and MODE 0 the LFSR advances on every clock", () => {
  const c = freshChip();
  E.stepClock(c, PRN | 3, 0, 1);
  const a = c.lfsr;
  E.stepClock(c, PRN | 3, 0, 1);
  assert.equal(c.lfsr, E.lfsrNext(a));
});

test("the LFSR holds its state when another opcode is selected", () => {
  const c = freshChip();
  E.stepClock(c, PRN | 3, 0, 1);
  const hold = c.lfsr;
  E.stepClock(c, MAC, 0, 1);
  E.stepClock(c, MAC, 0, 1);
  assert.equal(c.lfsr, hold);
});

test("the pin-level LFSR bitstream matches the reference sequence for 255 cycles", () => {
  const c = freshChip();
  E.stepClock(c, PRN | 1, 0, 1);
  E.stepClock(c, PRN | 1, 1, 1);
  let l = c.lfsr;
  for (let i = 0; i < 255; i++) {
    const r = E.stepClock(c, PRN | 1, 0, 1);
    l = E.lfsrNext(l);
    assert.equal(r.uoOut, l);
  }
});

test("the CRC pin path matches crc8Byte for a 6-bit message", () => {
  const c = freshChip();
  let ref = 0;
  for (const v of [1, 2, 63, 17, 40]) {
    pulse(c, PRN | v, 2);
    ref = E.crc8Byte(ref, v);
  }
  assert.equal(c.crc, ref);
  assert.equal(E.outputs(c, 0).uoOut, ref);
});

test("BIST: clearing the CRC and feeding 0..63 always ends at the same signature", () => {
  const sig = [];
  for (let run = 0; run < 2; run++) {
    const c = freshChip();
    pulse(c, PRN | 5, 2);
    pulse(c, PRN, 6);
    for (let i = 0; i < 64; i++) pulse(c, PRN | i, 2);
    sig.push(c.crc);
  }
  assert.equal(sig[0], sig[1]);
  let ref = 0;
  for (let i = 0; i < 64; i++) ref = E.crc8Byte(ref, i);
  assert.equal(sig[0], ref);
});

test("the BIST signature for 0..63 is the published value in NOTES and README", () => {
  let ref = 0;
  for (let i = 0; i < 64; i++) ref = E.crc8Byte(ref, i);
  const hex = "0x" + ref.toString(16).toUpperCase().padStart(2, "0");
  assert.ok(fs.readFileSync(path.join(root, "README.md"), "utf8").includes(hex), hex);
});

// ---- flags --------------------------------------------------------------
test("SIGN mirrors bit 7 of the displayed byte", () => {
  const c = freshChip();
  pulse(c, MAC | (-1 & 0x3f), 0);
  const o = E.outputs(c, 0);
  assert.equal(o.uoOut, 0xff);
  assert.equal(o.flags.sign, 1);
  assert.equal((o.uioOut >> 7) & 1, 1);
});

test("the low nibble of uio_out is always zero", () => {
  const c = freshChip();
  for (let i = 0; i < 100; i++) {
    const r = E.stepClock(c, (i * 37) & 0xff, (i * 91) & 0xff, 1);
    assert.equal(r.uioOut & 0x0f, 0);
  }
});

// ---- pipeline frames, VCD, metrics --------------------------------------
test("runCordicPipeline returns the start state plus 8 micro-rotations", () => {
  const r = E.runCordicPipeline({ kind: "rotate", angle: 11 });
  assert.equal(r.frames.length, 9);
  assert.equal(r.frames[0].stage, -1);
  assert.equal(r.frames[0].x, 311);
  assert.ok(r.frames.slice(1).every((f) => f.d === 1 || f.d === -1));
});

test("rotation direction follows the sign of z at every stage", () => {
  const r = E.runCordicPipeline({ kind: "rotate", angle: 21 });
  for (let k = 1; k < r.frames.length; k++) {
    const prev = r.frames[k - 1];
    assert.equal(r.frames[k].d, prev.z < 0 ? -1 : 1);
  }
});

test("generateVcdWaveform writes a valid header, 11 variables and rising timestamps", () => {
  const r = E.runCordicPipeline({ kind: "rotate", angle: 6 });
  const vcd = E.generateVcdWaveform(r.trace);
  assert.match(vcd, /\$timescale 1 ns \$end/);
  assert.match(vcd, /\$enddefinitions \$end/);
  assert.equal((vcd.match(/\$var wire/g) || []).length, 11);
  const times = vcd.split("\n").filter((l) => l[0] === "#").map((l) => Number(l.slice(1)));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1]);
});

test("the VCD contains the final z register value as a binary vector", () => {
  const r = E.runCordicPipeline({ kind: "rotate", angle: 6 });
  const vcd = E.generateVcdWaveform(r.trace);
  const last = r.trace[r.trace.length - 1];
  assert.ok(vcd.includes("b" + (last.z & 0xfff).toString(2).padStart(12, "0") + " )"));
});

test("gate metrics: block cells add up to the total and shares sum to one", () => {
  const m = E.synthesizeGateNetlistMetrics();
  assert.equal(m.blocks.reduce((s, b) => s + b.cells, 0), m.totalCells);
  assert.ok(Math.abs(m.blocks.reduce((s, b) => s + b.share, 0) - 1) < 1e-9);
  assert.equal(m.tileAreaUm2, 54400);
});

test("embedded gate statistics equal docs/synth-stats.json", () => {
  const j = JSON.parse(fs.readFileSync(path.join(root, "docs", "synth-stats.json"), "utf8"));
  const g = E.GATE_STATS;
  assert.equal(g.total_cells, j.total_cells);
  assert.equal(g.total_flipflops, j.total_flipflops);
  assert.equal(g.total_logic, j.total_logic);
  for (const name of Object.keys(j.modules)) assert.deepEqual({ ...g.modules[name] }, j.modules[name]);
});

test("the CORDIC core holds the largest share of the design", () => {
  const m = E.synthesizeGateNetlistMetrics();
  const core = m.blocks.find((b) => b.name === "aariv_cordic_core");
  assert.ok(core.share > 0.5);
});

test("pipeline traces keep the pins of their own operation on ui_in for every cycle", () => {
  const v = E.runCordicPipeline({ kind: "vector", xin: 5, yin: -7 });
  assert.ok(v.trace.every((r) => r.uiIn >> 6 === E.OP.VECTOR));
  assert.equal(v.trace[v.trace.length - 1].uiIn & 0x3f, -7 & 0x3f);
  const r = E.runCordicPipeline({ kind: "rotate", angle: -9 });
  assert.ok(r.trace.every((t) => t.uiIn >> 6 === E.OP.ROTATE));
  assert.equal(r.trace[r.trace.length - 1].uiIn & 0x3f, -9 & 0x3f);
});

test("pin value 32 is the signed angle -32 (minus 90 degrees), and the docs say so", () => {
  // ui_in[5:0] = 0b100000 is two's complement -32, so it rotates to minus 90 degrees, not plus 90.
  const c = freshChip();
  E.stepClock(c, ROT | 32, 0, 1);
  E.stepClock(c, ROT | 32, 1, 1); // START rising edge with ui_in[5:0] = 32
  for (let i = 0; i < 10; i++) E.stepClock(c, ROT | 32, 0, 1);
  assert.equal((E.outputs(c, 4).uoOut << 24) >> 24, -128); // sin(-90 degrees)
  assert.ok(Math.abs((E.outputs(c, 0).uoOut << 24) >> 24) <= 2); // cos(-90 degrees)
  for (const f of ["docs/info.md", "WRITEUP.md", "index.html"]) {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/A = 32 is 90/.test(text), `${f} must not call A = 32 plus 90 degrees`);
    assert.ok(/87\.2 degrees/.test(text), `${f} gives the top of the range, 87.2 degrees`);
  }
});
