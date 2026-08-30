#!/usr/bin/env python3
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "workers" / "migrator.js"
text = path.read_text(encoding="utf-8")

old_load = '''async function loadStats(env) {
  if (!env?.TELEMETRY) return emptyStats();
  try {
    const raw = await env.TELEMETRY.get("stats");
    if (!raw) return emptyStats();
    const data = JSON.parse(raw);
    return { ...emptyStats(), ...data };
  } catch {
    return emptyStats();
  }
}

async function persistEvent(env, event) {
  if (!env?.TELEMETRY) return;
  const stats = await loadStats(env);
  const step = event.step || "unknown";
  stats.byStep[step] = (stats.byStep[step] || 0) + 1;
  if (event.version) {
    stats.byVersion[event.version] = (stats.byVersion[event.version] || 0) + 1;
  }
  if (step === "page_view") stats.pageViews += 1;
  if (step === "start") stats.started += 1;
  if (step === "migration_confirmed") stats.confirmed += 1;
  if (step === "completed") stats.completed += 1;
  if (step === "failed") stats.failed += 1;

  stats.recent.unshift(event);
  stats.recent = stats.recent.slice(0, 150);

  if (step !== "page_view" && event.ip && event.ip !== "unknown") {
    const idx = stats.servers.findIndex((s) => s.ip === event.ip);
    const row = {
      ip: event.ip,
      firstSeen: idx >= 0 ? stats.servers[idx].firstSeen : event.ts,
      lastSeen: event.ts,
      lastStep: step,
      version: event.version,
      mode: event.mode,
      run: event.run || null,
    };
    if (idx >= 0) stats.servers[idx] = { ...stats.servers[idx], ...row };
    else {
      stats.uniqueIps += 1;
      stats.servers.unshift(row);
    }
    stats.servers = stats.servers.slice(0, 250);
  }

  await env.TELEMETRY.put("stats", JSON.stringify(stats));
}'''

new_load = '''function applyEvent(stats, event) {
  const step = event.step || "unknown";
  stats.byStep[step] = (stats.byStep[step] || 0) + 1;
  if (event.version) {
    stats.byVersion[event.version] = (stats.byVersion[event.version] || 0) + 1;
  }
  if (step === "page_view") stats.pageViews += 1;
  if (step === "start") stats.started += 1;
  if (step === "migration_confirmed") stats.confirmed += 1;
  if (step === "completed") stats.completed += 1;
  if (step === "failed") stats.failed += 1;

  stats.recent.unshift(event);
  stats.recent = stats.recent.slice(0, 150);

  if (step !== "page_view" && event.ip && event.ip !== "unknown") {
    const idx = stats.servers.findIndex((s) => s.ip === event.ip);
    const row = {
      ip: event.ip,
      firstSeen: idx >= 0 ? stats.servers[idx].firstSeen : event.ts,
      lastSeen: event.ts,
      lastStep: step,
      version: event.version,
      mode: event.mode,
      run: event.run || null,
    };
    if (idx >= 0) stats.servers[idx] = { ...stats.servers[idx], ...row };
    else {
      stats.uniqueIps += 1;
      stats.servers.unshift(row);
    }
    stats.servers = stats.servers.slice(0, 250);
  }
  return stats;
}

function doStub(env) {
  if (!env?.TELEMETRY_DO) return null;
  return env.TELEMETRY_DO.get(env.TELEMETRY_DO.idFromName("global"));
}

async function loadStats(env) {
  const stub = doStub(env);
  if (!stub) return emptyStats();
  try {
    const res = await stub.fetch("https://telemetry/stats");
    if (!res.ok) return emptyStats();
    return { ...emptyStats(), ...(await res.json()) };
  } catch {
    return emptyStats();
  }
}

async function persistEvent(env, event) {
  const stub = doStub(env);
  if (!stub) return;
  await stub.fetch("https://telemetry/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

export class TelemetryStore {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch(request) {
    let stats = (await this.ctx.storage.get("stats")) || emptyStats();
    if (request.method === "POST") {
      const event = await request.json();
      stats = applyEvent(stats, event);
      await this.ctx.storage.put("stats", stats);
      return new Response("ok");
    }
    return Response.json(stats);
  }
}'''

if old_load not in text:
    raise SystemExit("loadStats block not found")
text = text.replace(old_load, new_load)
path.write_text(text, encoding="utf-8", newline="\n")
print("ok", path.stat().st_size)
