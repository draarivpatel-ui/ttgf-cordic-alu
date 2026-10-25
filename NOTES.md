# Build notes

Status as of the last commit, with what is known, what is guessed and what is open.

## Origin and disclosure

This project was built by an AI assistant at the account owner's request. Hack Club ASIC (https://asic.hackclub.com/) says on its resources, write-up and submission pages that AI may not generate the HDL, the tests or the write up. The brief asked for a Hack Club submission anyway, so the work was kept as a disclosed reference design. Every public surface says so (README first paragraph, `info.yaml`, the page notice and footer, the first line of `WRITEUP.md`). It must not be submitted to either Hack Club form unless the rules change or the design is rewritten by the account owner.

## Decisions

* The brief listed `uio` flags for BUSY, ZERO, OVERFLOW, SIGN and the iteration counter. Only four flags fit beside four control inputs, so the iteration counter is left off the pins. It is visible in the simulator and in the VCD.
* The brief asked for a 6 bit angle with a Q1.7 atan table. The table is stored in units of pi/64 with 4 fractional bits (9 bit entries), because that keeps the 6 bit operand range at plus or minus 90 degrees. Outputs are Q1.7.
* The brief called opcode 10 a leaky integrator. It is a plain saturating accumulator with gain 1 or 3, so no leak. The name "MAC" is kept because it multiplies by a small constant and adds.
* The vectoring operation needs two operands but only one 6 bit pin group exists, so x and y are loaded in two START pulses.
* The brief said "about 320 cells" and "well below a 500 gate limit". Yosys with generic gates gives 835 cells. That number is not a GF180MCU standard cell count, and the real limit for one tile was not found in any source that was read. Neither number is used as a claim anywhere.
* Tests use `node --test` with no dependencies. The DOM tests run `app.js` against a small stub built from `index.html`. Real layout and interaction were checked in headless Chrome driven over the DevTools protocol, which exercised every preset, switch, pin, floorplan block and the VCD link.

## Honesty ledger

| Claim | Evidence |
| --- | --- |
| Verilog equals the JavaScript twin | `tests/cosim.test.js`, 320,028 cycles, every output and 12 internal values |
| The comparison can fail | Changing `ATAN_Q[3]` in `engine.js`, or the LFSR mask in `project.v`, made both seeds fail |
| Verilog is right against maths, not only against its twin | `test/test.py` against `math` and a Python CRC-8, 7 of 7 pass under Icarus Verilog 13 and cocotb 2.1.0 |
| 835 generic cells | `tools/synth_stats.py` (Yosys 0.70), written to `docs/synth-stats.json` |
| CRC-8 is the standard CRC-8 | check string `123456789` gives 0xF4 |

## Open items

1. Decide whether this stays a private reference. If it should go public, the four workflows in `.github/workflows` come from the Tiny Tapeout template and will run on the first push. The `gds` job is what finally says whether the design fits one tile.
2. The repository has not been pushed and Pages has not been enabled. Planned commands are in the last section.
3. The account owner would need to write the Hack Club write up from `WRITEUP.md` and run the design on an FPGA before any submission, and decide first whether an AI assisted design is allowed.
4. Timing is unanalysed. `clock_hz: 1000000` is a cautious placeholder.
5. Vectors shorter than 4 units are imprecise (about 6 counts of angle error) because x and y keep only 3 fractional bits there.
6. The page loads three Google fonts from `fonts.googleapis.com`. Self host them if a privacy rule needs it.

## Planned publishing commands

Not yet run.

```
git remote -v   # confirm nothing is configured
gh repo create draarivpatel-ui/ttgf-cordic-alu --public --source=. --push
gh api -X POST repos/draarivpatel-ui/ttgf-cordic-alu/pages -f "source[branch]=main" -f "source[path]=/"
curl -sI https://aariv.me/ttgf-cordic-alu/   # check what status comes back
```
