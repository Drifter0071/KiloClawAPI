"""Clear the dashboard-v2/dist directory in a way that works around
the Windows permission-denial Vite hits on its own emptyDir step.

Moves the dist dir aside to mavis-trash, then creates a fresh empty
one in its place so Vite can write to it cleanly.
"""
import os
import shutil
from pathlib import Path

ROOT = Path(r"C:/Users/garvanger/Documents/GitHub/KiloClawAPI")
DIST = ROOT / "cmms-api" / "dashboard-v2" / "dist"
TRASH = ROOT / "mavis-trash" / "vite-restore"

if DIST.exists():
    TRASH.mkdir(parents=True, exist_ok=True)
    target = TRASH / f"dist-{os.getpid()}"
    shutil.move(str(DIST), str(target))
    print(f"Staged previous dist at: {target}")
else:
    print("No existing dist to clear.")

DIST.mkdir(parents=True, exist_ok=True)
print(f"Fresh empty dist at: {DIST}")
