#!/usr/bin/env python3
"""Run Yosys on src/project.v and write docs/synth-stats.json.

Generic gate mapping only (AND, NAND, OR, NOR, XOR, XNOR, MUX, NOT plus flip-flops).
This is NOT a GF180MCU place-and-route result; the Tiny Tapeout GDS workflow gives that.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
top = "tt_um_aariv_cordic_alu"
with tempfile.TemporaryDirectory() as tmp:
    tmp_cwd = tmp
    (Path(tmp) / "src").mkdir()
    (Path(tmp) / "src" / "project.v").write_text((root / "src" / "project.v").read_text())
    out = Path(tmp) / "stat.json"
    script = (
        "read_verilog src/project.v; "
        f"synth -top {top}; abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX; opt_clean; "
        "tee -q -o stat.json stat -json"
    )
    subprocess.run(["yosys", "-q", "-p", script], check=True, cwd=tmp_cwd)
    data = json.loads(out.read_text())

modules = {}
for name, m in data["modules"].items():
    name = name.lstrip("\\")
    cells = m.get("num_cells_by_type", {})
    ffs = sum(v for k, v in cells.items() if "DFF" in k)
    total = m["num_cells"]
    modules[name] = {"cells": total, "flipflops": ffs, "logic": total - ffs}

total_cells = sum(v["cells"] for v in modules.values())
total_ffs = sum(v["flipflops"] for v in modules.values())
result = {
    "tool": "yosys " + subprocess.run(["yosys", "-V"], capture_output=True, text=True).stdout.split()[1],
    "mapping": "generic gates (AND NAND OR NOR XOR XNOR MUX NOT) + flip-flops, not GF180MCU",
    "top": top,
    "total_cells": total_cells,
    "total_flipflops": total_ffs,
    "total_logic": total_cells - total_ffs,
    "modules": modules,
}
(root / "docs" / "synth-stats.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
