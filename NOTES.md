# Build notes

Status as of the last commit, with what is known, what is guessed and what is open.

## Origin and disclosure

This project was built by an AI assistant at the account owner's request. Hack Club ASIC (https://asic.hackclub.com/) says on its resources, write-up and submission pages that AI may not generate the HDL, the tests or the write up. The brief asked for a Hack Club submission anyway, so the work was kept as a disclosed reference design. Every public surface says so (README first paragraph, `info.yaml`, the page notice and footer, the first line of `WRITEUP.md`). It must not be submitted to either Hack Club form unless the rules change or the design is rewritten by the account owner.

## Decisions

* The brief listed `uio` flags for BUSY, ZERO, OVERFLOW, SIGN and the iteration counter. Only four flags fit beside four control inputs, so the iteration counter is left off the pins. It is visible in the simulator and in the VCD.
* The brief asked for a 6 bit angle with a Q1.7 atan table. The table is stored in units of pi/64 with 4 fractional bits (9 bit entries), because that keeps the signed 6 bit operand range at minus 90 to plus 87.2 degrees. Outputs are Q1.7.
* The brief called opcode 10 a leaky integrator. It is a plain saturating accumulator with gain 1 or 3, so no leak. The name "MAC" is kept because it multiplies by a small constant and adds.
* The vectoring operation needs two operands but only one 6 bit pin group exists, so x and y are loaded in two START pulses.
* The brief said "about 320 cells" and "well below a 500 gate limit". Both are wrong. Yosys with generic gates gives 835 cells, and the Tiny Tapeout flow mapped the design to 894 GF180MCU cells covering 19,575 um^2 inside a 51,967 um^2 core, so it does fit one tile. No 500 cell limit was found in any source that was read.
* Tests use `node --test` with no dependencies. The DOM tests run `app.js` against a small stub built from `index.html`. Real layout and interaction were checked in headless Chrome driven over the DevTools protocol, which exercised every preset, switch, pin, floorplan block and the VCD link.

## Honesty ledger

| Claim | Evidence |
| --- | --- |
| Verilog equals the JavaScript twin | `tests/cosim.test.js`, 320,028 cycles, both output bytes and 10 internal registers, 12 values per clock |
| The comparison can fail | Changing `ATAN_Q[3]` in `engine.js`, or the LFSR mask in `project.v`, made both seeds fail |
| Verilog is right against maths, not only against its twin | `test/test.py` against `math` and a Python CRC-8, 7 of 7 pass under Icarus Verilog 13 and cocotb 2.1.0 |
| 835 generic cells | `tools/synth_stats.py` (Yosys 0.70), written to `docs/synth-stats.json` |
| 894 GF180MCU cells, 19,575 um^2, fits one tile | GitHub Actions `gds` run 40216982627, synthesis statistics in its log. `gds`, `precheck` (DRC 0 violations) and `gl_test` succeeded |
| CRC-8 is the standard CRC-8 | check string `123456789` gives 0xF4 |

## Open items

1. The repository is public and Pages is served from `main` at https://aariv.me/ttgf-cordic-alu/. The Tiny Tapeout `viewer` job fails because it needs Pages deployed through Actions. Switching Pages to Actions would fix the viewer and would stop `main` serving the workbench, so it was left as is.
2. The first `gds` run failed because `src/config.json` was missing. It was added in the second commit.
3. The account owner would need to write the Hack Club write up from `WRITEUP.md` and run the design on an FPGA before any submission, and decide first whether an AI assisted design is allowed.
4. No timing report was read. `clock_hz: 1000000` is a cautious placeholder.
5. Vectors shorter than 4 units are imprecise (about 6 counts of angle error) because x and y keep only 3 fractional bits there.
6. The page loads three Google fonts from `fonts.googleapis.com`. Self host them if a privacy rule needs it.
