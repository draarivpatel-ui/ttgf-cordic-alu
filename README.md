# tt_um_aariv_cordic_alu

**Read this first.** This repository is an AI assisted reference design for the Tiny Tapeout GF180MCU flow, built to study CORDIC arithmetic. Hack Club ASIC does not allow AI written chip code, tests or write ups, so this is not an eligible Hack Club ASIC entry and nothing here has been submitted to that program. It has not been taped out and it has not been run on any hardware.

It is a multiplier-free CORDIC and fixed-point tile with four operations selected by `ui_in[7:6]`.

| Opcode | Operation | What it gives |
| --- | --- | --- |
| 00 | CORDIC rotation, 8 stages | cos and sin of a 6 bit angle, Q1.7 |
| 01 | CORDIC vectoring, 8 stages | length times 1.6467 and the angle of an (x, y) pair |
| 10 | Saturating accumulate, gain 1 or 3 | 8 bit signed accumulator and an overflow flag |
| 11 | Galois LFSR (period 255) and CRC-8 | pseudo random bytes and a checksum |

Open `index.html` (or the project page) for an interactive workbench with the input switches, a clock, a logic analyzer view with VCD export, a unit circle view of the eight micro-rotations, and a floorplan sketch.

## What is verified

| Check | Result |
| --- | --- |
| `src/project.v` compiles under Icarus Verilog 13 with `-Wall` | clean |
| Verilog and `engine.js` compared after every clock edge, all outputs and 12 internal values | identical for 320,028 cycles over two seeds, directed sweeps plus random pins and resets |
| The comparison detects a one constant change on either side | yes, checked by hand mutation |
| cocotb tests in `test/test.py` against Python `math` and a Python CRC-8 | 7 of 7 pass under Icarus Verilog |
| Rotation error against `Math.cos` and `Math.sin`, all 64 angles | worst 1.73 LSB (cos) and 1.45 LSB (sin) |
| Vectoring error, all 4095 nonzero inputs | length within 1.07 counts, angle within 1.15 counts at length 8 or more, up to 6 below length 4 |
| CRC-8 check string `123456789` | 0xF4, the standard value for polynomial 0x07 |
| CRC-8 of the bytes 0 to 63, used as a built in self test signature | 0x8E |
| Yosys 0.70 generic gate count (`tools/synth_stats.py`) | 835 cells, 75 of them flip-flops |
| Tiny Tapeout `gds` workflow on GitHub (LibreLane, GF180MCU 7 track library, run 40216982627) | built. Mapped to 894 standard cells (75 `dffq_1`) with a synthesized area of 19,575 um^2, 24 percent of it flip-flops, inside a core of 51,967 um^2. Magic and routing DRC reported clear |
| `precheck` and `gl_test` jobs in the same run | both succeeded, precheck DRC reported 0 violations, the gate-level test passed |
| `test` workflow on GitHub (cocotb under Icarus Verilog) | succeeded |

## What is not verified

* The `viewer` job of the Tiny Tapeout `gds` workflow fails. It wants to deploy to GitHub Pages through Actions, and this repository serves Pages from the `main` branch so the workbench stays online. The layout itself built and passed the checks above.
* The `fpga` workflow has not been read or confirmed, and no layout image has been reviewed by a person.
* No FPGA or logic analyzer run.
* No timing report has been read. `clock_hz` in `info.yaml` is a conservative choice (the template's own clock period is 20 ns), not a measured limit.

## Run the checks

```
npm test                       # unit, co-simulation and page smoke tests (needs iverilog for the co-simulation)
python3 tools/synth_stats.py   # re-run Yosys and rewrite docs/synth-stats.json
cd test && make                # cocotb tests, from a path without spaces
```

## Files

| Path | Purpose |
| --- | --- |
| `src/project.v` | the design |
| `info.yaml`, `docs/info.md` | Tiny Tapeout metadata and datasheet text |
| `test/` | Tiny Tapeout testbench, cocotb tests and a replay bench for the co-simulation |
| `engine.js` | cycle accurate JavaScript twin of the Verilog |
| `index.html`, `styles.css`, `app.js` | the workbench page |
| `tests/` | `node --test` suites |
| `WRITEUP.md` | measured facts to write from, not a write up |
| `NOTES.md` | build notes and open items |

## Licence

Apache-2.0, see `LICENSE`.
