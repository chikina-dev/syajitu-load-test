#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import net from "node:net";

const SERVERS = ["server1", "server2", "server3", "server4", "server5", "server6", "server7"];
const REPEATS = 3;
const SECONDS = 30;
const PROBE_INTERVAL_MS = 500;
const TIMEOUT_MS = 1000;
const execFileAsync = promisify(execFile);

const SCENARIOS = [
  { name: "short-random", concurrency: 240, payload: "random", size: 16, slow: false },
  { name: "short-same", concurrency: 240, payload: "same", size: 16, slow: false },
  { name: "huge-random", concurrency: 80, payload: "random", size: 65536, slow: false },
  { name: "huge-same", concurrency: 80, payload: "same", size: 65536, slow: false },
  { name: "slow-header", concurrency: 80, payload: "same", size: 16, slow: true },
];

if (process.env.INNER === "1") {
  await inner();
} else {
  await outer();
}

async function outer() {
  const outDir = join("results", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  const summaries: any[] = [];
  const metrics: any[] = [];

  console.log(`out=${outDir}`);
  console.log(`seconds=${SECONDS} repeats=${REPEATS} probe_every=${PROBE_INTERVAL_MS}ms scenarios=${SCENARIOS.map((x) => x.name).join(",")}`);

  for (const scenario of SCENARIOS) {
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      for (const server of SERVERS) {
        run("docker", ["compose", "up", "-d", "--force-recreate", server]);
        const result = await testServer(server, scenario, repeat);
        run("docker", ["compose", "stop", server]);

        metrics.push(...result.rows.map((r: any) => ({ scenario: scenario.name, run: repeat, server, ...r })));
        summaries.push(result.summary);
        printOne(result.summary);
      }
    }
  }

  const medians = medianSummaries(summaries);
  writeFileSync(join(outDir, "metrics.csv"), metricsCsv(metrics));
  writeFileSync(join(outDir, "summary.csv"), summaryCsv(summaries));
  writeFileSync(join(outDir, "summary_median.csv"), medianCsv(medians));
  printSummary(medians);
}

async function testServer(server: string, scenario: any, repeat: number) {
  const started = Date.now();
  const stats: any[] = [];
  let attackOut = "";
  let probeOut = "";
  let attackErr = "";
  let probeErr = "";
  let attackDone = false;
  let probeDone = false;

  console.log(`\n[${server} ${scenario.name} run=${repeat}] attack -> ${server}:8080, probe -> ${server}:8080`);
  const attack = runInner(server, "attack", scenario.name);
  const probe = runInner(server, "probe", scenario.name);

  attack.stdout.on("data", (x) => attackOut += x.toString());
  attack.stderr.on("data", (x) => attackErr += x.toString());
  attack.on("close", () => attackDone = true);
  probe.stdout.on("data", (x) => probeOut += x.toString());
  probe.stderr.on("data", (x) => probeErr += x.toString());
  probe.on("close", () => probeDone = true);

  while (!attackDone || !probeDone) {
    stats.push({ second: Math.floor((Date.now() - started) / 1000), ...(await dockerStats(server)) });
    await sleep(1000);
  }

  if (attackErr.trim()) process.stderr.write(attackErr);
  if (probeErr.trim()) process.stderr.write(probeErr);

  const attackResult = marker(attackOut);
  const probeResult = marker(probeOut);
  const rows = mergeRows(attackResult.rows, probeResult.rows, stats);
  const inspect = inspectDocker(server);
  const summary = {
    scenario: scenario.name,
    run: repeat,
    server,
    attackTotal: attackResult.summary.total,
    attackOk: attackResult.summary.ok,
    attack503: attackResult.summary.busy503,
    attackFailed: attackResult.summary.failed,
    probeTotal: probeResult.summary.total,
    probeOk: probeResult.summary.ok,
    probeFailed: probeResult.summary.failed,
    probeSuccessRate: probeResult.summary.total ? probeResult.summary.ok / probeResult.summary.total : 0,
    probeAvgMs: probeResult.summary.avgMs,
    probeP95Ms: probeResult.summary.p95Ms,
    firstProbeFailureSecond: probeResult.summary.firstFailureSecond,
    firstProbeLowSuccessSecond: probeResult.summary.firstLowSuccessSecond,
    firstDownSecond: first(rows, (r) => r.running === 0),
    firstOomSecond: first(rows, (r) => r.oomKilled === 1),
    cpuMaxPercent: max(rows, "cpuPercent"),
    memMaxMiB: max(rows, "memMiB"),
    memMaxPercent: max(rows, "memPercent"),
    pidsMax: max(rows, "pids"),
    exitCode: inspect.exitCode,
    running: inspect.running,
    oomKilled: inspect.oomKilled,
  };

  return { rows, summary };
}

function runInner(server: string, role: string, scenario: string) {
  return spawn("docker", [
    "compose", "run", "--rm",
    "-e", "INNER=1",
    "-e", `ROLE=${role}`,
    "-e", `TARGET=${server}`,
    "-e", `SCENARIO=${scenario}`,
    "loadtest",
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

async function inner() {
  const role = process.env.ROLE || "attack";
  const target = process.env.TARGET || "server1";
  const scenario = findScenario(process.env.SCENARIO || "short-random");
  const started = Date.now();
  const endAt = started + SECONDS * 1000;
  const rows: any[] = [];
  const latencies: number[] = [];
  let bucket = newBucket(0);
  let firstFailureSecond = -1;
  let firstLowSuccessSecond = -1;

  const timer = setInterval(flush, 1000);

  if (role === "probe") {
    while (Date.now() < endAt) {
      await hitOnce(0, { ...scenario, payload: "probe", size: 16, slow: false });
      await sleep(PROBE_INTERVAL_MS);
    }
  } else if (scenario.slow) {
    await Promise.all(Array.from({ length: scenario.concurrency }, (_, id) => slowHold(target, id, endAt)));
  } else {
    await Promise.all(Array.from({ length: scenario.concurrency }, (_, id) => attackLoop(id)));
  }

  clearInterval(timer);
  flush();

  const total = sum(rows, "total");
  const ok = sum(rows, "ok");
  const sorted = latencies.sort((a, b) => a - b);
  console.log(`__RESULT__${JSON.stringify({
    rows,
    summary: {
      role,
      total,
      ok,
      busy503: sum(rows, "busy503"),
      failed: sum(rows, "failed"),
      timeout: sum(rows, "timeout"),
      connectError: sum(rows, "connectError"),
      avgMs: avg(sorted),
      p95Ms: pct(sorted, 0.95),
      p99Ms: pct(sorted, 0.99),
      firstFailureSecond,
      firstLowSuccessSecond,
    },
  })}`);

  async function attackLoop(id: number) {
    while (Date.now() < endAt) await hitOnce(id, scenario);
  }

  async function hitOnce(id: number, mode: any) {
    const before = performance.now();
    const res = await request(target, id, role, mode);
    record(res, performance.now() - before);
  }

  async function slowHold(host: string, id: number, endAtMs: number) {
    const before = performance.now();
    const res = await slowRequest(host, id, endAtMs);
    record(res, performance.now() - before);
  }

  function record(res: any, msRaw: number) {
    const ms = round(msRaw);
    const sec = Math.floor((Date.now() - started) / 1000);
    bucket.total++;
    if (res.status === 200) bucket.ok++;
    else if (res.status === 503) bucket.busy503++;
    else bucket.failed++;
    if (res.error === "timeout") bucket.timeout++;
    if (res.error === "connect") bucket.connectError++;
    if ((res.status !== 200 || res.error) && firstFailureSecond < 0) firstFailureSecond = sec;
    bucket.latencies.push(ms);
    latencies.push(ms);
  }

  function flush() {
    if (bucket.total === 0 && rows.length > 0) return;
    const sorted = bucket.latencies.sort((a, b) => a - b);
    const successRate = bucket.total ? bucket.ok / bucket.total : 1;
    if (bucket.total > 0 && successRate < 0.5 && firstLowSuccessSecond < 0) {
      firstLowSuccessSecond = bucket.second;
    }
    rows.push({
      second: bucket.second,
      total: bucket.total,
      ok: bucket.ok,
      busy503: bucket.busy503,
      failed: bucket.failed,
      timeout: bucket.timeout,
      connectError: bucket.connectError,
      avgMs: avg(sorted),
      p95Ms: pct(sorted, 0.95),
      p99Ms: pct(sorted, 0.99),
    });
    bucket = newBucket(Math.floor((Date.now() - started) / 1000));
  }
}

function request(host: string, id: number, role: string, scenario: any): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    let data = "";
    const socket = net.createConnection({ host, port: 8080 });
    const timer = setTimeout(() => finish(0, "timeout"), TIMEOUT_MS);

    socket.on("connect", () => socket.write(httpText(host, id, role, scenario)));
    socket.on("data", (chunk) => data += chunk.toString("latin1"));
    socket.on("end", () => finish(status(data), ""));
    socket.on("error", () => finish(0, "connect"));
    socket.on("close", () => { if (!done) finish(status(data), data ? "" : "connect"); });

    function finish(code: number, error: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: code, error });
    }
  });
}

function slowRequest(host: string, id: number, endAt: number): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    let i = 0;
    let data = "";
    const text = httpText(host, id, "slow", { payload: "same", size: 16 });
    const socket = net.createConnection({ host, port: 8080 });
    const tick = setInterval(() => {
      if (done || Date.now() >= endAt) return finish(status(data), data ? "" : "timeout");
      if (i < text.length) socket.write(text[i++]);
    }, 250);

    socket.on("data", (chunk) => data += chunk.toString("latin1"));
    socket.on("end", () => finish(status(data), ""));
    socket.on("error", () => finish(0, "connect"));
    socket.on("close", () => { if (!done) finish(status(data), data ? "" : "connect"); });

    function finish(code: number, error: string) {
      if (done) return;
      done = true;
      clearInterval(tick);
      socket.destroy();
      resolve({ status: code, error });
    }
  });
}

function httpText(host: string, id: number, role: string, scenario: any) {
  const name = nameValue(id, role, scenario);
  return `GET /?name=${name} HTTP/1.0\r\nHost: ${host}\r\n\r\n`;
}

function nameValue(id: number, role: string, scenario: any) {
  if (scenario.payload === "probe") return `normal-${Date.now()}-${id}`;
  if (scenario.payload === "same") return "attack-" + "x".repeat(Math.max(0, scenario.size - 7));
  return `${role}-${Date.now()}-${id}-` + "x".repeat(Math.max(0, scenario.size));
}

function mergeRows(attackRows: any[], probeRows: any[], stats: any[]) {
  const seconds = new Set([...attackRows, ...probeRows, ...stats].map((r) => r.second));
  return [...seconds].sort((a, b) => a - b).map((second) => {
    const a = attackRows.find((r) => r.second === second) || {};
    const p = probeRows.find((r) => r.second === second) || {};
    const s = stats.find((r) => r.second >= second) || stats[stats.length - 1] || {};
    return {
      second,
      attackTotal: a.total || 0,
      attackOk: a.ok || 0,
      attack503: a.busy503 || 0,
      attackFailed: a.failed || 0,
      probeTotal: p.total || 0,
      probeOk: p.ok || 0,
      probeFailed: p.failed || 0,
      probeAvgMs: p.avgMs || 0,
      probeP95Ms: p.p95Ms || 0,
      cpuPercent: s.cpuPercent || 0,
      memBytes: s.memBytes || 0,
      memMiB: s.memMiB || 0,
      memPercent: s.memPercent || 0,
      pids: s.pids || 0,
      running: s.running ?? -1,
      oomKilled: s.oomKilled ?? -1,
    };
  });
}

async function dockerStats(server: string) {
  try {
    const out = await execFileAsync("docker", ["stats", "--no-stream", "--format", "{{json .}}", server], { encoding: "utf8" });
    const row = JSON.parse(out.stdout.trim().split("\n")[0] || "{}");
    const state = await inspectDockerAsync(server);
    const memBytes = bytes(String(row.MemUsage || "").split("/")[0]);
    return {
      cpuPercent: num(row.CPUPerc),
      memBytes,
      memMiB: round(memBytes / 1024 / 1024),
      memPercent: num(row.MemPerc),
      pids: Number(row.PIDs || 0),
      running: state.running === null ? -1 : state.running ? 1 : 0,
      oomKilled: state.oomKilled === null ? -1 : state.oomKilled ? 1 : 0,
    };
  } catch {
    const state = await inspectDockerAsync(server);
    return { cpuPercent: 0, memBytes: 0, memMiB: 0, memPercent: 0, pids: 0, running: state.running === null ? -1 : state.running ? 1 : 0, oomKilled: state.oomKilled === null ? -1 : state.oomKilled ? 1 : 0 };
  }
}

async function inspectDockerAsync(server: string) {
  try {
    const out = await execFileAsync("docker", ["inspect", server], { encoding: "utf8" });
    return parseState(out.stdout);
  } catch {
    return { running: null, oomKilled: null, exitCode: null };
  }
}

function inspectDocker(server: string) {
  const out = spawnSync("docker", ["inspect", server], { encoding: "utf8" });
  return out.status === 0 ? parseState(out.stdout) : { running: null, oomKilled: null, exitCode: null };
}

function parseState(text: string) {
  const state = JSON.parse(text)[0]?.State || {};
  return { running: Boolean(state.Running), oomKilled: Boolean(state.OOMKilled), exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null };
}

function marker(text: string) {
  const line = text.split("\n").find((x) => x.startsWith("__RESULT__"));
  if (!line) throw new Error("missing inner result");
  return JSON.parse(line.slice("__RESULT__".length));
}

function run(cmd: string, args: string[]) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status || 1);
}

function metricsCsv(rows: any[]) {
  return csv(["scenario", "run", "server", "second", "attackTotal", "attackOk", "attack503", "attackFailed", "probeTotal", "probeOk", "probeFailed", "probeAvgMs", "probeP95Ms", "cpuPercent", "memBytes", "memMiB", "memPercent", "pids", "running", "oomKilled"], rows);
}

function summaryCsv(rows: any[]) {
  return csv(["scenario", "run", "server", "attackTotal", "attackOk", "attack503", "attackFailed", "probeTotal", "probeOk", "probeFailed", "probeSuccessRate", "probeAvgMs", "probeP95Ms", "firstProbeFailureSecond", "firstProbeLowSuccessSecond", "firstDownSecond", "firstOomSecond", "cpuMaxPercent", "memMaxMiB", "memMaxPercent", "pidsMax", "exitCode", "running", "oomKilled"], rows);
}

function medianCsv(rows: any[]) {
  return csv(["scenario", "server", "runs", "attackTotal", "attackOk", "attack503", "attackFailed", "probeTotal", "probeOk", "probeFailed", "probeSuccessRate", "probeAvgMs", "probeP95Ms", "firstProbeFailureSecond", "firstProbeLowSuccessSecond", "firstDownSecond", "firstOomSecond", "cpuMaxPercent", "memMaxMiB", "memMaxPercent", "pidsMax", "oomKilled"], rows);
}

function printOne(s: any) {
  console.log(`${s.scenario} run=${s.run} ${s.server}: probe=${s.probeOk}/${s.probeTotal} attack=${s.attackTotal} 503=${s.attack503} first_fail=${s.firstProbeFailureSecond}s mem=${s.memMaxMiB}MiB oom=${s.oomKilled}`);
}

function printSummary(rows: any[]) {
  console.log("\nmedian: scenario,server,runs,probe_ok,probe_total,probe_success%,attack_total,attack_503,first_probe_fail,mem_mib,oom");
  for (const s of rows) {
    console.log([s.scenario, s.server, s.runs, s.probeOk, s.probeTotal, round(s.probeSuccessRate * 100), s.attackTotal, s.attack503, s.firstProbeFailureSecond, s.memMaxMiB, s.oomKilled].join(","));
  }
}

function medianSummaries(rows: any[]) {
  const groups: Record<string, any[]> = {};
  for (const row of rows) {
    const key = `${row.scenario}\t${row.server}`;
    (groups[key] ||= []).push(row);
  }

  return Object.values(groups).map((xs) => {
    const firstRow = xs[0];
    const out: any = {
      scenario: firstRow.scenario,
      server: firstRow.server,
      runs: xs.length,
      oomKilled: xs.some((x) => x.oomKilled),
    };

    for (const key of ["attackTotal", "attackOk", "attack503", "attackFailed", "probeTotal", "probeOk", "probeFailed", "probeSuccessRate", "probeAvgMs", "probeP95Ms", "firstProbeFailureSecond", "firstProbeLowSuccessSecond", "firstDownSecond", "firstOomSecond", "cpuMaxPercent", "memMaxMiB", "memMaxPercent", "pidsMax"]) {
      out[key] = median(xs.map((x) => Number(x[key] ?? 0)));
    }

    return out;
  });
}

function findScenario(name: string) {
  return SCENARIOS.find((x) => x.name === name) || SCENARIOS[0];
}

function newBucket(second: number) {
  return { second, total: 0, ok: 0, busy503: 0, failed: 0, timeout: 0, connectError: 0, latencies: [] as number[] };
}

function csv(headers: string[], rows: any[]) {
  return [headers.join(","), ...rows.map((r) => headers.map((h) => r[h] ?? "").join(","))].join("\n") + "\n";
}

function status(data: string) {
  return Number(data.match(/^HTTP\/[0-9.]+\s+(\d+)/)?.[1] || 0);
}

function sum(rows: any[], key: string) {
  return rows.reduce((n, r) => n + Number(r[key] || 0), 0);
}

function max(rows: any[], key: string) {
  return rows.length ? Math.max(...rows.map((r) => Number(r[key] || 0))) : 0;
}

function first(rows: any[], test: (row: any) => boolean) {
  return rows.find(test)?.second ?? -1;
}

function avg(xs: number[]) {
  return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
}

function median(xs: number[]) {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return round(sorted[mid]);
  return round((sorted[mid - 1] + sorted[mid]) / 2);
}

function pct(xs: number[], p: number) {
  return xs.length ? round(xs[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)]) : 0;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function num(value: unknown) {
  return Number(String(value || "0").replace("%", "")) || 0;
}

function bytes(value: string) {
  const m = value.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith("g")) return n * 1024 * 1024 * 1024;
  if (u.startsWith("m")) return n * 1024 * 1024;
  if (u.startsWith("k")) return n * 1024;
  return n;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
