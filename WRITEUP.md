# Facts for a write up (this file is not the write up)

Hack Club ASIC asks for a write up that a person writes without AI, and it says that using AI to create the write up is strictly forbidden. This file therefore does not try to be one. It collects the measured numbers and the open questions so that a person who builds or studies this design can write their own account in their own words, using their own understanding.

Everything below was measured in this repository. Anything not listed was not measured.

## Numbers you can quote

| Item | Value | Where it came from |
| --- | --- | --- |
| CORDIC stages | 8, one per clock | `src/project.v`, `aariv_cordic_core` |
| Result latency | 8 clocks after the START edge | `tests/engine.test.js`, `test/test.py` |
| Rotation angle unit | pi/64 per count, A = 32 is 90 degrees | `src/project.v` |
| Worst cosine error | 1.73 LSB of 1/128 | `E.rotationErrorReport()` over all 64 angles |
| Worst sine error | 1.45 LSB | same |
| Worst length error | 1.07 counts | all 4095 nonzero (x, y) pairs |
| Worst angle error | 1.15 counts (1 count is 1.40625 degrees), vectors of length 8 or more | same |
| Angle error for vectors shorter than 4 | up to 6 counts | same |
| Generic gate count | 835 cells, 75 flip-flops | `docs/synth-stats.json`, Yosys 0.70 |
| Cells per block | core 454, top level 240, MAC 92, PRBS and CRC 49 | same |
| LFSR period | 255 | `tests/engine.test.js`, `test/test.py` |
| CRC-8 check value for `123456789` | 0xF4 | `tests/engine.test.js` |
| BIST signature, CRC-8 of bytes 0 to 63 | 0x8E | `tests/engine.test.js` |
| Verilog against JavaScript twin | identical for 320,028 clock cycles | `tests/cosim.test.js` |

## Not measured

Standard cell count after GF180MCU mapping, tile utilisation, timing, power, and anything on real hardware. Do not write any of these as facts until they are measured.

## Questions a write up should answer, in the author's own words

1. Why does turning by atan(2^-i) need only a shift and an add, and why do the eight turns grow the vector by 1.6467?
2. Walk one rotation by A = 10 through the logic analyzer view. Why does `z_reg` fall toward zero while `x_reg` and `y_reg` change? Use the VCD export from the workbench.
3. Why does a vector with a negative x need a 90 degree pre-rotation, and what goes wrong without it?
4. Why is the angle error larger for very short vectors? Look at how many fractional bits `x` and `y` keep there.
5. What would you change to fit more stages, and what would it cost in gates?
6. What failed or surprised you while building, testing or reading this design?
7. How will you test it on an FPGA with a logic analyzer, and what will you compare the captured waveforms against?

## Pictures worth including

The workbench can export a VCD (waveform file). The pinout and floorplan figures on the project page are sketches, so label them as sketches. A real layout picture will only exist after the Tiny Tapeout GDS workflow runs.
