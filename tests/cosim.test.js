"use strict";
// Co-simulation: replay the same stimulus through Icarus Verilog and the JS twin,
// then compare every output and internal register after every clock edge.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildStimulus, stimulusToHex, jsTrace } = require("./helpers.js");

const root = path.resolve(__dirname, "..");
const have = (cmd) => spawnSync(cmd, ["-V"], { encoding: "utf8" }).error === undefined;
const skip = !(have("iverilog") && have("vvp")) && "iverilog and vvp are not installed";

const RANDOM_CYCLES = 150000;
const SEEDS = [1, 20261130];

function runVerilog(cycles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cordic-cosim-"));
  try {
    const exe = path.join(dir, "replay.vvp");
    const stim = path.join(dir, "stim.hex");
    fs.writeFileSync(stim, stimulusToHex(cycles));
    const build = spawnSync("iverilog", ["-g2012", "-Wno-timescale", "-o", exe,
      path.join(root, "src", "project.v"), path.join(root, "test", "replay.v")], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync("vvp", [exe, `+stim=${stim}`, `+n=${cycles.length}`],
      { encoding: "utf8", maxBuffer: 1 << 30 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.split("\n").filter((l) => /^[0-9a-f]{2} /.test(l));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const seed of SEEDS) {
  test(`Verilog and JS twin agree on every register for seed ${seed}`, { skip }, () => {
    const cycles = buildStimulus(RANDOM_CYCLES, seed);
    const v = runVerilog(cycles);
    const j = jsTrace(cycles);
    assert.equal(v.length, cycles.length, "Verilog produced one line per cycle");
    for (let i = 0; i < v.length; i++) {
      if (v[i] !== j[i]) {
        assert.fail(`cycle ${i}: verilog "${v[i]}" vs js "${j[i]}" (stimulus ${cycles[i]})`);
      }
    }
  });
}

test("stimulus covers all four opcodes, resets and START edges", () => {
  const cycles = buildStimulus(RANDOM_CYCLES, 1);
  const ops = new Set(cycles.map(([, , ui]) => ui >> 6));
  assert.equal(ops.size, 4);
  assert.ok(cycles.some(([r]) => r === 0 && cycles.indexOf(cycles.find(([rr]) => rr === 1)) < cycles.length));
  assert.ok(cycles.filter(([, uio]) => (uio & 1) === 1).length > 1000);
  assert.ok(cycles.length > RANDOM_CYCLES);
});
