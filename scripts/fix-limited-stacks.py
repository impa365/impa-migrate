#!/usr/bin/env python3
"""Re-deploy app stacks via Portainer API (SetupOrion style) — fixes Limited status."""
import json
import re
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
KEEP = {"traefik", "portainer"}
PRIORITY = ["postgres", "pgvector"]


def load(p):
    d = {}
    for line in Path(p).read_text(encoding="utf-8").splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            d[k.strip().lower()] = v.strip()
    return d


def ssh(ip, pw, cmd, t=300):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(ip, username="root", password=pw, timeout=20, look_for_keys=False, allow_agent=False)
    _, o, e = c.exec_command(cmd, timeout=t)
    return o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")


def read_dados_portainer(ip, pw):
  out, _ = ssh(ip, pw, "cat /root/dados_vps/dados_portainer 2>/dev/null || true")
  data = {}
  for line in out.splitlines():
    line = line.strip()
    if line.startswith("Dominio do portainer:"):
      data["domain"] = line.split(":", 1)[1].strip()
    elif line.startswith("Usuario:"):
      data["user"] = line.split(":", 1)[1].strip()
    elif line.startswith("Senha:"):
      data["pass"] = line.split(":", 1)[1].strip()
  return data


def portainer_api(ip, pw, domain, user, password):
  ssh(ip, pw, "command -v jq >/dev/null 2>&1 || apt-get install -y -qq jq >/dev/null")
  script = f"""
set -euo pipefail
DOMAIN={json.dumps(domain)}
USER={json.dumps(user)}
PASS={json.dumps(password)}
TOKEN=$(curl -sk -X POST -H "Content-Type: application/json" -H "Host: $DOMAIN" \\
  -d "{{\\"username\\":\\"$USER\\",\\"password\\":\\"$PASS\\"}}" \\
  https://127.0.0.1/api/auth | jq -r '.jwt // empty')
[ -z "$TOKEN" ] && echo AUTH_FAIL && exit 1
ENDPOINT_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \\
  https://127.0.0.1/api/endpoints | jq -r '.[] | select(.Name == "primary") | .Id')
SWARM_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \\
  "https://127.0.0.1/api/endpoints/$ENDPOINT_ID/docker/swarm" | jq -r '.ID')
printf '%s\\n' "$TOKEN" "$ENDPOINT_ID" "$SWARM_ID"
"""
  out, err = ssh(ip, pw, script)
  lines = [l.strip() for l in out.splitlines() if l.strip()]
  if not lines or lines[0] == "AUTH_FAIL":
    raise RuntimeError(f"Portainer auth failed: {err or out}")
  return {"token": lines[0], "endpoint_id": lines[1], "swarm_id": lines[2], "domain": domain}


def find_yaml(ip, pw, name):
  cmd = f"""
if [ -f /root/impa-exported-stacks/{name}.yaml ]; then echo /root/impa-exported-stacks/{name}.yaml; exit 0; fi
if [ -f /root/{name}.yaml ]; then echo /root/{name}.yaml; exit 0; fi
if [ -f /root/{name}.yml ]; then echo /root/{name}.yml; exit 0; fi
exit 1
"""
  out, _ = ssh(ip, pw, cmd)
  path = out.strip().splitlines()[-1].strip() if out.strip() else ""
  return path if path.startswith("/root/") else ""


def deploy_via_portainer(ip, pw, api, name, yaml_path):
  script = f"""
set -euo pipefail
TOKEN={json.dumps(api['token'])}
DOMAIN={json.dumps(api['domain'])}
ENDPOINT_ID={json.dumps(api['endpoint_id'])}
SWARM_ID={json.dumps(api['swarm_id'])}
NAME={json.dumps(name)}
YAML={json.dumps(yaml_path)}

STACK_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \\
  https://127.0.0.1/api/stacks | jq -r --arg n "$NAME" '.[] | select(.Name == $n) | .Id' | head -1)
if [ -n "$STACK_ID" ] && [ "$STACK_ID" != "null" ]; then
  curl -sk -X DELETE -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \\
    "https://127.0.0.1/api/stacks/${{STACK_ID}}?external=true&endpointId=${{ENDPOINT_ID}}" >/dev/null 2>&1 || true
  sleep 3
fi
if docker stack ls --format '{{{{.Name}}}}' 2>/dev/null | grep -qx "$NAME"; then
  docker stack rm "$NAME" >/dev/null 2>&1 || true
  sleep 10
fi
HTTP=$(curl -sk -o /tmp/impa_fix_resp.json -w "%{{http_code}}" -X POST \\
  -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \\
  -F "Name=$NAME" -F "file=@$YAML" -F "SwarmID=$SWARM_ID" -F "endpointId=$ENDPOINT_ID" \\
  https://127.0.0.1/api/stacks/create/swarm/file)
if [ "$HTTP" = "200" ] && grep -q '"Id"' /tmp/impa_fix_resp.json; then echo OK; else cat /tmp/impa_fix_resp.json; exit 1; fi
"""
  out, err = ssh(ip, pw, script)
  if "OK" not in out:
    raise RuntimeError(out.strip() or err.strip())


def portainer_active_stacks(ip, pw, api):
  script = f"""
set -euo pipefail
TOKEN={json.dumps(api['token'])}
DOMAIN={json.dumps(api['domain'])}
curl -sk -H "Authorization: Bearer $TOKEN" -H "Host: $DOMAIN" \\
  https://127.0.0.1/api/stacks 2>/dev/null \\
  | jq -r '.[] | select(.Status == 1) | .Name' | grep -vxE 'traefik|portainer' || true
"""
  out, _ = ssh(ip, pw, script)
  return [s.strip() for s in out.splitlines() if s.strip()]


def main():
  dest = load(ROOT / "vps destino.txt")
  ip, pw = dest["ip"], dest["senha"]

  creds = read_dados_portainer(ip, pw)
  domain = creds.get("domain", "").replace("https://", "").replace("http://", "").strip("/")
  if not domain:
    out, _ = ssh(ip, pw, r"grep -oE 'Host\(`[^`]+`\)' /root/portainer.yaml | head -1")
    m = re.search(r"Host\(`([^`]+)`\)", out)
    domain = m.group(1) if m else "portainer.local"
  if not creds.get("user") or not creds.get("pass"):
    raise SystemExit("dados_portainer ausente no destino — defina usuário/senha primeiro")

  print("=== Portainer API ===")
  api = portainer_api(ip, pw, domain, creds["user"], creds["pass"])
  print(f"endpoint={api['endpoint_id']} swarm={api['swarm_id'][:12]}…")

  deploy_list = portainer_active_stacks(ip, pw, api)
  if not deploy_list:
    out, _ = ssh(ip, pw, "docker stack ls --format '{{.Name}}'")
    deploy_list = [s.strip() for s in out.splitlines() if s.strip() and s.strip() not in KEEP]
    print("Aviso: sem stacks ativas no Portainer — fallback docker stack ls")

  print("\n=== Stacks a redeployar (ativas no Portainer) ===")
  print("\n".join(deploy_list) if deploy_list else "(nenhuma)")

  ordered = [s for s in PRIORITY if s in deploy_list]
  for s in deploy_list:
    if s not in ordered:
      ordered.append(s)

  print(f"\n=== Redeploy via Portainer API ({len(ordered)} apps) ===")
  for name in ordered:
    path = find_yaml(ip, pw, name)
    if not path:
      print(f"  SKIP {name} (sem yaml)")
      continue
    print(f"  {name} ({path})...")
    try:
      deploy_via_portainer(ip, pw, api, name, path)
      print("    OK")
    except RuntimeError as e:
      print(f"    FAIL: {str(e)[:200]}")
    time.sleep(4)

  print("\n=== Final ===")
  out, _ = ssh(ip, pw, "docker stack ls && echo --- && docker service ls --format '{{.Name}} {{.Replicas}}' | head -25")
  print(out)
  print("\nAtualize o Portainer (F5) — apps devem sair de Limited (traefik/portainer podem continuar).")


if __name__ == "__main__":
  main()
