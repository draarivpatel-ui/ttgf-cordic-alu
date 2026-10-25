<!---
Datasheet text for tt_um_aariv_cordic_alu. This design is an AI assisted reference design and is
not a Hack Club ASIC entry. See README.md.
-->

## How it works

The tile holds four small blocks that share the Tiny Tapeout pins.

**CORDIC core.** Three registers hold `x` and `y` (11 bit signed) and `z` (12 bit signed). On each clock edge during an operation, the core applies one micro-rotation for stage `i`, from 0 to 7. It computes `x -/+ (y >>> i)`, `y +/- (x >>> i)` and `z -/+ atan[i]`, where `atan[i]` is an eight entry table in units of pi/64 with four fractional bits (256, 151, 80, 41, 20, 10, 5, 3). The result is ready after 8 clocks and `BUSY` is high while it runs. There is no multiplier anywhere in the design.

In rotation mode, `z` starts at the operand angle and `x` starts at 311, which is 512 divided by the CORDIC gain of 1.6467. The sign of `z` picks the turn direction. At the end `x` is cosine and `y` is sine, both in Q2.9, and the output stage shifts them to Q1.7 and saturates to a signed byte.

In vectoring mode, the sign of `y` picks the turn direction and the core drives `y` to zero. At the end `x` holds the vector length times 1.6467 and `z` holds the angle. Input operands are loaded with three fractional bits. A vector with a negative x is first turned by plus or minus 90 degrees so that the loop converges.

**Saturating MAC.** An 8 bit signed accumulator adds the operand A, or 3A when `GAIN3` is high (one shift and one add). The sum clamps to 127 or -128 and `OVERFLOW` shows that the last add was clamped.

**LFSR.** A Galois LFSR with polynomial x^8 + x^6 + x^5 + x^4 + 1 (feedback mask 0x71) visits all 255 nonzero states. It starts at 0x01 after reset.

**CRC-8.** A bitwise CRC-8 with polynomial 0x07 and initial value 0 absorbs the 6 bit operand, zero extended to a byte, on each feed.

### Pins

| Pin | Role |
| --- | --- |
| `ui_in[5:0]` | Operand A, signed 6 bit |
| `ui_in[7:6]` | Opcode, 00 rotate, 01 vector, 10 MAC, 11 PRBS and CRC |
| `uio[0]` | START, acts on a rising edge |
| `uio[1]` | MODE, second form of an operation |
| `uio[2]` | RSEL, shows the second result on `uo_out` |
| `uio[3]` | GAIN3, MAC gain of 3 |
| `uio[4]` | BUSY, output |
| `uio[5]` | ZERO, output, `uo_out` is 00 |
| `uio[6]` | OVERFLOW, output, saturated rotation result or clamped MAC add |
| `uio[7]` | SIGN, output, copy of `uo_out[7]` |
| `uo_out[7:0]` | Result byte |

### Operations

| Opcode | Run it | `uo_out` |
| --- | --- | --- |
| 00 | Put A on `ui_in[5:0]` and give START a rising edge. A is an angle in units of pi/64, so A = 32 is 90 degrees. | RSEL 0 shows cos, RSEL 1 shows sin, Q1.7 |
| 01 | START with MODE 0 loads x = A. Then START with MODE 1 loads y = A and runs. | RSEL 0 shows length times 1.6467, RSEL 1 shows the angle in counts of 1/128 of a half turn |
| 10 | START adds A, or 3A with GAIN3. START with MODE 1 clears. | accumulator |
| 11 | MODE 0 free runs the LFSR, START loads the seed 01 followed by A. MODE 1 with START feeds A to the CRC, and with RSEL also high it clears the CRC. | LFSR state, or CRC after a feed |

Measured against `math.cos`, `math.sin` and `math.atan2` over every input, the worst cosine error is 1.73 LSB and the worst sine error is 1.45 LSB (one LSB is 1/128). The worst length error is 1.07 counts. The worst angle error is 1.15 counts for vectors of length 8 or more, and up to about 6 counts for vectors shorter than 4.

## How to test

Run the cocotb tests in `test/` with Icarus Verilog. Each opcode has a directed test, and the expected values come from Python `math` and a Python CRC-8. A second check lives in `tests/cosim.test.js`, which replays random stimulus through the Verilog and the JavaScript twin in `engine.js` and compares every output and register after every clock edge.

On hardware, drive `ui_in` and `uio_in[3:0]` from switches, give START a clean rising edge, wait 8 clocks and read `uo_out` and `uio_out[7:4]` with a logic analyzer. The hardware run has not been done yet.

## External hardware

None needed. Switches or a microcontroller for the inputs and a logic analyzer for the outputs are enough.
