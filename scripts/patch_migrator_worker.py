import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
install_sh = (root / 'impamigrate' / 'install.sh').read_text(encoding='utf-8')
worker_js_file = root / 'workers' / 'migrator.js'
worker_js = worker_js_file.read_text(encoding='utf-8')

embedded = json.dumps(install_sh)

idx1 = worker_js.find('const PAINEL_INSTALL_URL =')
idx2 = worker_js.find('async function serveScript()')

if idx1 != -1 and idx2 != -1:
    new_fn = (
        'const PAINEL_INSTALL_SH = ' + embedded + ';\n\n'
        'function servePainelScript() {\n'
        '  return new Response(PAINEL_INSTALL_SH, {\n'
        '    status: 200,\n'
        '    headers: {\n'
        '      "Content-Type": "text/plain; charset=utf-8",\n'
        '      "Cache-Control": "no-store",\n'
        '      "X-IMPA-Migrator": "painel-script",\n'
        '      "X-IMPA-Version": VERSION,\n'
        '    },\n'
        '  });\n'
        '}\n\n'
    )
    worker_js = worker_js[:idx1] + new_fn + worker_js[idx2:]
    worker_js_file.write_text(worker_js, encoding='utf-8')
    print('SUCCESS: workers/migrator.js updated with embedded install.sh!')
else:
    print('Markers not found: idx1 =', idx1, 'idx2 =', idx2)
