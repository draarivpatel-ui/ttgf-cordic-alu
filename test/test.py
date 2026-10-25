# SPDX-License-Identifier: Apache-2.0
# Directed cocotb tests for tt_um_aariv_cordic_alu. Expected values come from math.cos,
# math.sin, math.atan2 and a plain Python CRC-8, not from engine.js.

import math

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles

OP_ROT, OP_VEC, OP_MAC, OP_PRN = 0x00, 0x40, 0x80, 0xC0
START, MODE, RSEL, GAIN3 = 1, 2, 4, 8


def s8(v):
    return v - 256 if v & 0x80 else v


async def reset(dut):
    cocotb.start_soon(Clock(dut.clk, 10, unit="us").start())
    dut.ena.value = 1
    dut.ui_in.value = 0
    dut.uio_in.value = 0
    dut.rst_n.value = 0
    await ClockCycles(dut.clk, 4)
    dut.rst_n.value = 1
    await ClockCycles(dut.clk, 2)


async def pulse(dut, ui, uio=0):
    """Hold START low, raise it for one clock, drop it again."""
    dut.ui_in.value = ui
    dut.uio_in.value = uio & ~START
    await ClockCycles(dut.clk, 1)
    dut.uio_in.value = uio | START
    await ClockCycles(dut.clk, 1)
    dut.uio_in.value = uio & ~START
    await ClockCycles(dut.clk, 1)


def crc8(c, d):
    t = (c ^ d) & 0xFF
    for _ in range(8):
        t = ((t << 1) ^ 0x07) & 0xFF if t & 0x80 else (t << 1) & 0xFF
    return t


@cocotb.test()
async def test_reset_state(dut):
    await reset(dut)
    assert int(dut.uo_out.value) == 0
    assert int(dut.uio_oe.value) == 0xF0
    assert int(dut.uio_out.value) == 0x20  # ZERO flag only


@cocotb.test()
async def test_rotate_matches_math(dut):
    await reset(dut)
    for a in (-32, -16, -5, 0, 7, 10, 23, 31):
        ui = OP_ROT | (a & 0x3F)
        await pulse(dut, ui)
        await ClockCycles(dut.clk, 10)
        assert int(dut.uio_out.value) & 0x10 == 0, "BUSY should have dropped"
        rad = a * math.pi / 64
        dut.uio_in.value = 0
        await ClockCycles(dut.clk, 1)
        cos_q = s8(int(dut.uo_out.value))
        dut.uio_in.value = RSEL
        await ClockCycles(dut.clk, 1)
        sin_q = s8(int(dut.uo_out.value))
        assert abs(cos_q - min(127, math.cos(rad) * 128)) <= 2, (a, cos_q)
        assert abs(sin_q - min(127, math.sin(rad) * 128)) <= 2, (a, sin_q)
        dut.uio_in.value = 0


@cocotb.test()
async def test_busy_lasts_eight_clocks(dut):
    await reset(dut)
    ui = OP_ROT | 9
    dut.ui_in.value = ui
    dut.uio_in.value = 0
    await ClockCycles(dut.clk, 1)
    dut.uio_in.value = START
    await ClockCycles(dut.clk, 1)
    dut.uio_in.value = 0
    busy = 0
    for _ in range(20):
        await ClockCycles(dut.clk, 1)
        if int(dut.uio_out.value) & 0x10:
            busy += 1
    # one micro-rotation already happened in the first cycle of the loop above
    assert busy in (7, 8)


@cocotb.test()
async def test_vector_length_and_angle(dut):
    await reset(dut)
    for x, y in ((12, 9), (-10, 10), (5, -20), (-20, -3)):
        await pulse(dut, OP_VEC | (x & 0x3F), 0)
        await pulse(dut, OP_VEC | (y & 0x3F), MODE)
        await ClockCycles(dut.clk, 10)
        dut.uio_in.value = 0
        await ClockCycles(dut.clk, 1)
        mag = int(dut.uo_out.value)
        dut.uio_in.value = RSEL
        await ClockCycles(dut.clk, 1)
        ang = s8(int(dut.uo_out.value))
        want_mag = 1.646743506596901 * math.hypot(x, y)
        want_ang = math.atan2(y, x) * 128 / math.pi
        err = abs(ang - want_ang)
        err = min(err, 256 - err)
        assert abs(mag - want_mag) <= 1.2, (x, y, mag, want_mag)
        assert err <= 2.0, (x, y, ang, want_ang)
        dut.uio_in.value = 0


@cocotb.test()
async def test_mac_gain_clear_and_saturation(dut):
    await reset(dut)
    await pulse(dut, OP_MAC | 7, GAIN3)
    await pulse(dut, OP_MAC | 7, GAIN3)
    assert s8(int(dut.uo_out.value)) == 42
    await pulse(dut, OP_MAC, MODE)  # clear
    assert int(dut.uo_out.value) == 0
    for _ in range(8):
        await pulse(dut, OP_MAC | 31, GAIN3)
    assert s8(int(dut.uo_out.value)) == 127
    assert int(dut.uio_out.value) & 0x40, "OVERFLOW should be set"
    await pulse(dut, OP_MAC, MODE)
    for _ in range(8):
        await pulse(dut, OP_MAC | 32, GAIN3)
    assert s8(int(dut.uo_out.value)) == -128


@cocotb.test()
async def test_lfsr_has_period_255(dut):
    await reset(dut)
    await pulse(dut, OP_PRN | 5, 0)
    dut.ui_in.value = OP_PRN | 5
    dut.uio_in.value = 0
    await ClockCycles(dut.clk, 1)
    first = int(dut.uo_out.value)
    seen = {first}
    for _ in range(254):
        await ClockCycles(dut.clk, 1)
        seen.add(int(dut.uo_out.value))
    assert len(seen) == 255
    await ClockCycles(dut.clk, 1)
    assert int(dut.uo_out.value) == first


@cocotb.test()
async def test_crc8_signature(dut):
    await reset(dut)
    await pulse(dut, OP_PRN, MODE | RSEL)  # clear
    ref = 0
    for v in range(64):
        await pulse(dut, OP_PRN | v, MODE)
        ref = crc8(ref, v)
    assert int(dut.uo_out.value) == ref
