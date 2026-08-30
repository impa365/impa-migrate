#!/usr/bin/env python3
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "workers" / "migrator.js"
text = path.read_text(encoding="utf-8")

text = text.replace(
    "async function handleTelemetry(request) {",
    "async function handleTelemetry(request, env) {",
)
text = text.replace(
    "  const hook = typeof TELEMETRY_WEBHOOK !== \"undefined\" ? TELEMETRY_WEBHOOK : null;",
    "  const hook = env?.TELEMETRY_WEBHOOK || null;",
)
text = text.replace(
    "  async fetch(request) {",
    "  async fetch(request, env) {",
)
text = text.replace(
    "      return handleTelemetry(request);",
    "      return handleTelemetry(request, env);",
)
text = text.replace(
    "      <div><span class=\"brand-f\">IMPA 365</span> · créditos ao usar o Migrator</div>",
    "      <div><span class=\"brand-f\">IMPA 365</span> · créditos ao usar o Migrator<br><span style=\"opacity:.75\">Telemetria anônima de uso (etapa + versão) — sem senhas nem dados sensíveis.</span></div>",
)

path.write_text(text, encoding="utf-8", newline="\n")
print("fixed env + footer", path.stat().st_size)
