import base64
import io
import json
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent

# 1) Build impamigrate.tar.gz in memory
impamigrate_dir = root / "impamigrate"
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for f in impamigrate_dir.rglob("*"):
        if any(part in f.parts for part in (".git", "__pycache__", "dist")) or f.name.endswith(".pyc") or (f.name.startswith("_") and f.name != "__init__.py"):
            continue
        rel = f.relative_to(impamigrate_dir)
        tar.add(f, arcname=rel.as_posix(), recursive=False)

tar_bytes = buf.getvalue()
tar_b64 = base64.b64encode(tar_bytes).decode("ascii")
print(f"Tar.gz size: {len(tar_bytes)} bytes ({len(tar_bytes)/1024:.1f} KB), base64: {len(tar_b64)} chars")

# 2) Read install.sh
install_sh = (impamigrate_dir / "install.sh").read_text(encoding="utf-8")

# 3) Read workers/migrator.js
worker_file = root / "workers" / "migrator.js"
worker_js = worker_file.read_text(encoding="utf-8")

# Markers for replacement
marker_start = "const PAINEL_INSTALL_SH ="
marker_end = "async function serveScript() {"

idx1 = worker_js.find(marker_start)
idx2 = worker_js.find(marker_end)

if idx1 == -1 or idx2 == -1:
    print(f"Markers not found! idx1={idx1}, idx2={idx2}")
    exit(1)

embedded_script = json.dumps(install_sh)
embedded_tarball = json.dumps(tar_b64)

new_block = (
    f"const PAINEL_INSTALL_SH = {embedded_script};\n"
    f"const TARBALL_B64 = {embedded_tarball};\n\n"
    "function servePainelScript() {\n"
    "  return new Response(PAINEL_INSTALL_SH, {\n"
    "    status: 200,\n"
    "    headers: {\n"
    '      "Content-Type": "text/plain; charset=utf-8",\n'
    '      "Cache-Control": "no-store",\n'
    '      "X-IMPA-Migrator": "painel-script",\n'
    '      "X-IMPA-Version": VERSION,\n'
    "    },\n"
    "  });\n"
    "}\n\n"
    "function serveTarball() {\n"
    "  const binary = Uint8Array.from(atob(TARBALL_B64), (c) => c.charCodeAt(0));\n"
    "  return new Response(binary, {\n"
    "    status: 200,\n"
    "    headers: {\n"
    '      "Content-Type": "application/gzip",\n'
    '      "Cache-Control": "no-store",\n'
    '      "Content-Disposition": \'attachment; filename="impamigrate.tar.gz"\',\n'
    "    },\n"
    "  });\n"
    "}\n\n"
)

worker_js = worker_js[:idx1] + new_block + worker_js[idx2:]

# Ensure /impamigrate.tar.gz route in fetch()
if 'url.pathname === "/impamigrate.tar.gz"' not in worker_js:
    target = 'if (url.pathname === "/health") {'
    replacement = (
        'if (url.pathname === "/health") {\n'
        '      return new Response("ok", { headers: { "Content-Type": "text/plain" } });\n'
        '    }\n'
        '    if (url.pathname === "/impamigrate.tar.gz") {\n'
        '      return serveTarball();\n'
        '    }'
    )
    worker_js = worker_js.replace(
        'if (url.pathname === "/health") {\n      return new Response("ok", { headers: { "Content-Type": "text/plain" } });\n    }',
        replacement
    )

worker_file.write_text(worker_js, encoding="utf-8")
print(f"Updated {worker_file} successfully! Total size: {len(worker_js)} chars")
