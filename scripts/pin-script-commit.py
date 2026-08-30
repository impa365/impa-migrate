#!/usr/bin/env python3
import subprocess
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
h = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).decode().strip()
p = ROOT / "workers" / "migrator.js"
t = p.read_text(encoding="utf-8")
t = re.sub(r'const SCRIPT_COMMIT = "[^"]+";', f'const SCRIPT_COMMIT = "{h}";', t, count=1)
p.write_text(t, encoding="utf-8", newline="\n")
print(h)
