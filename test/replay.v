`default_nettype none
`timescale 1ns / 1ps

// Replays a stimulus file through the design and prints one line per clock edge.
// Used by tests/cosim.test.js to compare against engine.js. Run with
//   iverilog -g2012 -o replay.vvp src/project.v test/replay.v
//   vvp replay.vvp +stim=stim.hex +n=1000
// Stimulus word (20 bits, hex): {3'b0, rst_n, uio_in[7:0], ui_in[7:0]}
module replay;
  reg clk = 0;
  reg rst_n = 0;
  reg [7:0] ui_in = 0;
  reg [7:0] uio_in = 0;
  wire [7:0] uo_out, uio_out, uio_oe;
  reg [19:0] mem [0:262143];
  reg [1023:0] stim_name;
  integer n, i;

  tt_um_aariv_cordic_alu dut (
      .ui_in(ui_in), .uo_out(uo_out), .uio_in(uio_in), .uio_out(uio_out),
      .uio_oe(uio_oe), .ena(1'b1), .clk(clk), .rst_n(rst_n)
  );

  initial begin
    if (!$value$plusargs("stim=%s", stim_name)) begin
      $display("missing +stim=");
      $finish;
    end
    if (!$value$plusargs("n=%d", n)) n = 0;
    $readmemh(stim_name, mem);
    for (i = 0; i < n; i = i + 1) begin
      {rst_n, uio_in, ui_in} = mem[i][16:0];
      #5 clk = 1;
      #1;
      $display("%h %h %h %h %h %h %h %h %h %h %h %h", uo_out, uio_out, dut.cx, dut.cy,
               dut.cz, dut.citer, dut.cbusy, dut.view, dut.acc, dut.lfsr, dut.crc, dut.u_cordic.vec_mode);
      #4 clk = 0;
      #5;
    end
    $finish;
  end
endmodule
