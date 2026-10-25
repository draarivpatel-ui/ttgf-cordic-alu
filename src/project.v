/*
 * Copyright (c) 2026 draarivpatel-ui
 * SPDX-License-Identifier: Apache-2.0
 *
 * tt_um_aariv_cordic_alu: a multiplier-free CORDIC and fixed-point ALU tile.
 * Reference design, AI-assisted. See README.md for the disclosure.
 */

`default_nettype none

// ---------------------------------------------------------------------------
// CORDIC core. One micro-rotation per clock, 8 stages (i = 0..7).
//   x, y : 11-bit signed, 9 fractional bits for rotate (Q2.9)
//   z    : 12-bit signed, angle in units of pi/64 with 4 fractional bits
// ---------------------------------------------------------------------------
module aariv_cordic_core (
    input  wire               clk,
    input  wire               rst_n,
    input  wire               load,      // one-cycle pulse: load x0, y0, z0 and go
    input  wire               load_vec,  // 1 = vectoring mode, 0 = rotation mode
    input  wire signed [10:0] x0,
    input  wire signed [10:0] y0,
    input  wire signed [11:0] z0,
    output reg  signed [10:0] x,
    output reg  signed [10:0] y,
    output reg  signed [11:0] z,
    output reg  [2:0]         iter,
    output reg                busy
);
  reg vec_mode;

  // atan(2^-i) in units of pi/64 with 4 fractional bits, rounded to nearest.
  reg [8:0] atan_q;
  always @* begin
    case (iter)
      3'd0: atan_q = 9'd256;
      3'd1: atan_q = 9'd151;
      3'd2: atan_q = 9'd80;
      3'd3: atan_q = 9'd41;
      3'd4: atan_q = 9'd20;
      3'd5: atan_q = 9'd10;
      3'd6: atan_q = 9'd5;
      default: atan_q = 9'd3;
    endcase
  end

  wire signed [11:0] atan_s = {3'b000, atan_q};
  wire signed [10:0] xs = x >>> iter;  // barrel shifter, arithmetic
  wire signed [10:0] ys = y >>> iter;

  // d = +1 when rotating counter-clockwise: rotation mode looks at the sign of z,
  // vectoring mode looks at the sign of y.
  wire dpos = vec_mode ? y[10] : ~z[11];

  wire signed [10:0] xn = dpos ? (x - ys) : (x + ys);
  wire signed [10:0] yn = dpos ? (y + xs) : (y - xs);
  wire signed [11:0] zn = dpos ? (z - atan_s) : (z + atan_s);

  always @(posedge clk) begin
    if (!rst_n) begin
      x <= 11'sd0;
      y <= 11'sd0;
      z <= 12'sd0;
      iter <= 3'd0;
      busy <= 1'b0;
      vec_mode <= 1'b0;
    end else if (busy) begin
      x <= xn;
      y <= yn;
      z <= zn;
      iter <= iter + 3'd1;
      if (iter == 3'd7) busy <= 1'b0;
    end else if (load) begin
      x <= x0;
      y <= y0;
      z <= z0;
      iter <= 3'd0;
      busy <= 1'b1;
      vec_mode <= load_vec;
    end
  end
endmodule

// ---------------------------------------------------------------------------
// Saturating 8-bit multiply-accumulate. The "multiply" is a gain of 1 or 3,
// which is one shift and one add, so there is no hardware multiplier.
// ---------------------------------------------------------------------------
module aariv_mac8 (
    input  wire              clk,
    input  wire              rst_n,
    input  wire              do_acc,
    input  wire              do_clr,
    input  wire signed [5:0] a,
    input  wire              gain3,
    output reg  signed [7:0] acc,
    output reg               sat
);
  wire signed [7:0] a8 = {{2{a[5]}}, a};
  wire signed [7:0] prod = gain3 ? (a8 + (a8 <<< 1)) : a8;
  wire signed [8:0] sum = {acc[7], acc} + {prod[7], prod};
  wire over = (sum > 9'sd127);
  wire under = (sum < -9'sd128);

  always @(posedge clk) begin
    if (!rst_n || do_clr) begin
      acc <= 8'sd0;
      sat <= 1'b0;
    end else if (do_acc) begin
      acc <= over ? 8'sd127 : (under ? -8'sd128 : sum[7:0]);
      sat <= over | under;
    end
  end
endmodule

// ---------------------------------------------------------------------------
// Galois LFSR (x^8 + x^6 + x^5 + x^4 + 1, period 255) and CRC-8 (poly 0x07).
// ---------------------------------------------------------------------------
module aariv_prng_crc (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       lfsr_seed,   // load a seed
    input  wire       lfsr_step,   // advance one state
    input  wire [5:0] seed_a,
    input  wire       crc_feed,
    input  wire       crc_clear,
    input  wire [5:0] crc_a,
    output reg  [7:0] lfsr,
    output reg  [7:0] crc
);
  function [7:0] crc8_byte;
    input [7:0] c;
    input [7:0] d;
    integer k;
    reg [7:0] t;
    begin
      t = c ^ d;
      for (k = 0; k < 8; k = k + 1) t = t[7] ? ((t << 1) ^ 8'h07) : (t << 1);
      crc8_byte = t;
    end
  endfunction

  wire [7:0] lfsr_next = {lfsr[6:0], 1'b0} ^ (lfsr[7] ? 8'h71 : 8'h00);

  always @(posedge clk) begin
    if (!rst_n) begin
      lfsr <= 8'h01;
      crc <= 8'h00;
    end else begin
      if (lfsr_seed) lfsr <= {2'b01, seed_a};
      else if (lfsr_step) lfsr <= lfsr_next;
      if (crc_clear) crc <= 8'h00;
      else if (crc_feed) crc <= crc8_byte(crc, {2'b00, crc_a});
    end
  end
endmodule

// ---------------------------------------------------------------------------
// Top level.
//   ui_in[5:0] operand A (signed 6-bit), ui_in[7:6] opcode
//   uio_in[0] START (rising edge), [1] MODE, [2] RSEL, [3] GAIN3
//   uio_out[4] BUSY, [5] ZERO, [6] OVERFLOW, [7] SIGN   (uio_oe = 8'hF0)
// ---------------------------------------------------------------------------
module tt_um_aariv_cordic_alu (
    input  wire [7:0] ui_in,
    output wire [7:0] uo_out,
    input  wire [7:0] uio_in,
    output wire [7:0] uio_out,
    output wire [7:0] uio_oe,
    input  wire       ena,
    input  wire       clk,
    input  wire       rst_n
);
  wire [1:0] op = ui_in[7:6];
  wire signed [5:0] a = ui_in[5:0];
  wire start_pin = uio_in[0];
  wire mode = uio_in[1];
  wire rsel = uio_in[2];
  wire gain3 = uio_in[3];

  reg start_q;
  wire start = start_pin & ~start_q;

  // view: which block drives uo_out. 0 rotate, 1 vector, 2 mac, 3 lfsr, 4 crc
  reg [2:0] view;
  reg signed [5:0] xin;

  wire signed [10:0] cx, cy;
  wire signed [11:0] cz;
  wire [2:0] citer;
  wire cbusy;
  wire signed [7:0] acc;
  wire mac_sat;
  wire [7:0] lfsr, crc;

  wire op_rot = (op == 2'b00);
  wire op_vec = (op == 2'b01);
  wire op_mac = (op == 2'b10);
  wire op_prn = (op == 2'b11);

  // Vectoring set-up: x operand was latched earlier, y operand is on the pins.
  // x < 0 is folded into x >= 0 by a +-90 degree pre-rotation.
  wire signed [10:0] xa = {{2{xin[5]}}, xin, 3'b000};
  wire signed [10:0] ya = {{2{a[5]}}, a, 3'b000};
  wire v_fold = xin[5];
  wire v_ypos = ~a[5];
  wire signed [10:0] vx0 = ~v_fold ? xa : (v_ypos ? ya : -ya);
  wire signed [10:0] vy0 = ~v_fold ? ya : (v_ypos ? -xa : xa);
  wire signed [11:0] vz0 = ~v_fold ? 12'sd0 : (v_ypos ? 12'sd512 : -12'sd512);

  wire go_rot = start & ~cbusy & op_rot;
  wire go_vec = start & ~cbusy & op_vec & mode;
  wire ld_vec_x = start & ~cbusy & op_vec & ~mode;

  aariv_cordic_core u_cordic (
      .clk(clk), .rst_n(rst_n),
      .load(go_rot | go_vec), .load_vec(go_vec),
      .x0(go_vec ? vx0 : 11'sd311),
      .y0(go_vec ? vy0 : 11'sd0),
      .z0(go_vec ? vz0 : {{2{a[5]}}, a, 4'b0000}),
      .x(cx), .y(cy), .z(cz), .iter(citer), .busy(cbusy)
  );

  aariv_mac8 u_mac (
      .clk(clk), .rst_n(rst_n),
      .do_acc(start & ~cbusy & op_mac & ~mode),
      .do_clr(start & ~cbusy & op_mac & mode),
      .a(a), .gain3(gain3), .acc(acc), .sat(mac_sat)
  );

  wire prn_free = op_prn & ~mode & ~cbusy;
  aariv_prng_crc u_prng (
      .clk(clk), .rst_n(rst_n),
      .lfsr_seed(start & prn_free),
      .lfsr_step(prn_free & ~start),
      .seed_a(a[5:0]),
      .crc_feed(start & ~cbusy & op_prn & mode & ~rsel),
      .crc_clear(start & ~cbusy & op_prn & mode & rsel),
      .crc_a(a[5:0]),
      .lfsr(lfsr), .crc(crc)
  );

  always @(posedge clk) begin
    if (!rst_n) begin
      start_q <= 1'b0;
      view <= 3'd2;
      xin <= 6'sd0;
    end else begin
      start_q <= start_pin;
      if (ld_vec_x) xin <= a;
      if (go_rot) view <= 3'd0;
      else if (go_vec) view <= 3'd1;
      else if (start & ~cbusy & op_mac) view <= 3'd2;
      else if (prn_free) view <= 3'd3;
      else if (start & ~cbusy & op_prn & mode) view <= 3'd4;
    end
  end

  // Rotate view: Q2.9 to Q1.7, saturate to int8.
  wire signed [8:0] disp9 = rsel ? cy[10:2] : cx[10:2];
  wire rot_ovf = (disp9 > 9'sd127) | (disp9 < -9'sd128);
  wire [7:0] rot_out = (disp9 > 9'sd127) ? 8'h7F : ((disp9 < -9'sd128) ? 8'h80 : disp9[7:0]);

  reg [7:0] out_r;
  always @* begin
    case (view)
      3'd0: out_r = rot_out;
      3'd1: out_r = rsel ? cz[10:3] : cx[10:3];
      3'd2: out_r = acc;
      3'd3: out_r = lfsr;
      default: out_r = crc;
    endcase
  end

  wire ovf = (view == 3'd0) ? rot_ovf : ((view == 3'd2) ? mac_sat : 1'b0);

  assign uo_out = out_r;
  assign uio_out = {out_r[7], ovf, (out_r == 8'h00), cbusy, 4'b0000};
  assign uio_oe = 8'hF0;

  wire _unused = &{ena, citer, 1'b0};
endmodule
