"""Copy the dashboard-v2 build output to the served location.

Idempotent: stages the previous deployed tree to mavis-trash, then
mirrors the dist tree into the served location.
"""

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(r"C:/Users/garvanger/Documents/GitHub/KiloClawAPI")
SRC = ROOT / "cmms-api" / "dashboard-v2" / "dist"
DST = ROOT / "cmms-api" / "dashboard" / "v2"
TRASH = ROOT / "mavis-trash" / "deploy-restore"

if not SRC.is_dir():
    print(f"FATAL: dist not found: {SRC}", file=sys.stderr)
    sys.exit(1)

TRASH.mkdir(parents=True, exist_ok=True)
stamp = TRASH / f"v2-{os.getpid()}"
if DST.exists():
    shutil.move(str(DST), str(stamp))

shutil.copytree(str(SRC), str(DST))

file_count = sum(1 for _ in DST.rglob("*") if _.is_file())
print(f"Copied {file_count} files to {DST}")
print(f"Previous build staged at: {stamp}")
