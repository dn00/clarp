#!/usr/bin/env node
/**
 * Interactive PTY interrupt probe.
 *
 * Launches real `claude` (interactive) under node-pty and tests
 * interrupt/resume race conditions. Uses the same readiness signal
 * Clarp trusts: Claude's PID status file (~/.claude/sessions/<pid>.json).
 *
 * Usage:
 *   node scripts/pty-interrupt-probe.mjs [--runs 3] [--claude claude] [--out .parity-runs/pty-probe]
 *   node scripts/pty-interrupt-probe.mjs --scenario esc-then-prompt-b --runs 3
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

const ESC = "\x1b";
const CTRL_C = "\x03";
const ENTER = "\r";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readPidStatus(pid) {
  const p = join(homedir(), ".claude", "sessions", `${pid}.json`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

class PtyProbe {
  constructor(command, cwd) {
    this.command = command;
    this.cwd = cwd;
    this.proc = null;
    this.pid = null;
    this.output = [];
    this.rawOutput = "";
    this.timeline = [];
    this.statusLog = [];
    this.startedAt = 0;
    this.exited = false;
    this.exitInfo = null;
    this._statusPollTimer = null;
    this._lastStatus = null;
  }

  record(action, detail = {}) {
    this.timeline.push({ t: Date.now() - this.startedAt, action, ...detail });
  }

  start() {
    this.startedAt = Date.now();
    this.record("spawn", { command: this.command });

    this.proc = pty.spawn(this.command, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: this.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    this.pid = this.proc.pid;
    this.record("started", { pid: this.pid });

    this.proc.onData(data => {
      this.rawOutput += data;
      this.output.push({ t: Date.now() - this.startedAt, data });
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitInfo = { exitCode, signal };
      this.record("exit", this.exitInfo);
      this._stopStatusPoll();
    });

    this._startStatusPoll();
  }

  _startStatusPoll() {
    this._statusPollTimer = setInterval(() => {
      const data = readPidStatus(this.pid);
      if (!data) return;
      const status = data.status || "unknown";
      const waitingFor = data.waitingFor;
      if (status !== this._lastStatus) {
        const entry = { t: Date.now() - this.startedAt, status, waitingFor };
        this.statusLog.push(entry);
        this.record("pid_status", { status, waitingFor });
        this._lastStatus = status;
      }
    }, 200);
  }

  _stopStatusPoll() {
    if (this._statusPollTimer) {
      clearInterval(this._statusPollTimer);
      this._statusPollTimer = null;
    }
  }

  write(data, label) {
    if (this.exited) return;
    this.record("write", { label, bytes: Buffer.from(data).toString("hex") });
    this.proc.write(data);
  }

  sendPrompt(text) {
    this.write(text + ENTER, `prompt: ${text.slice(0, 60)}`);
  }

  sendEsc() {
    this.write(ESC, "ESC");
  }

  sendCtrlC() {
    this.write(CTRL_C, "Ctrl-C");
  }

  kill(signal = "SIGTERM") {
    if (this.exited) return;
    this.record("kill", { signal });
    this.proc.kill(signal);
  }

  currentStatus() {
    return readPidStatus(this.pid);
  }

  async waitForStatus(targetStatus, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.exited) return { reached: false, reason: "exited" };
      const data = readPidStatus(this.pid);
      if (data?.status === targetStatus) {
        this.record("status_reached", { status: targetStatus, afterMs: Date.now() - start });
        return { reached: true, afterMs: Date.now() - start, data };
      }
      await delay(200);
    }
    this.record("status_timeout", { wanted: targetStatus, timeoutMs, lastSeen: this._lastStatus });
    return { reached: false, reason: "timeout", lastSeen: this._lastStatus };
  }

  async waitForOutput(pattern, timeoutMs = 30000) {
    const start = Date.now();
    const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    while (Date.now() - start < timeoutMs) {
      if (regex.test(this.rawOutput)) {
        this.record("pattern_matched", { pattern: String(pattern), afterMs: Date.now() - start });
        return true;
      }
      if (this.exited) return false;
      await delay(200);
    }
    this.record("pattern_timeout", { pattern: String(pattern), timeoutMs });
    return false;
  }

  async destroy(timeoutMs = 5000) {
    this._stopStatusPoll();
    if (this.exited) return;
    this.kill("SIGTERM");
    const start = Date.now();
    while (!this.exited && Date.now() - start < timeoutMs) {
      await delay(100);
    }
    if (!this.exited) {
      this.kill("SIGKILL");
      await delay(500);
    }
  }

  getSummary() {
    const stripped = this.rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    return {
      pid: this.pid,
      timeline: this.timeline,
      statusLog: this.statusLog,
      exitInfo: this.exitInfo,
      outputLength: this.rawOutput.length,
      strippedTail: stripped.slice(-2000),
    };
  }
}

// ---- Scenarios ----

const SCENARIOS = {
  "esc-stops-turn": async (probe) => {
    const ready = await probe.waitForStatus("idle", 25000);
    if (!ready.reached) { probe.record("never_ready"); return; }

    probe.sendPrompt("Count from 1 to 100, one number per line");
    const busy = await probe.waitForStatus("busy", 10000);
    probe.record("busy_before_esc", busy);
    await delay(2000);

    probe.sendEsc();
    probe.record("esc_sent");
    const idled = await probe.waitForStatus("idle", 10000);
    probe.record("idle_after_esc", idled);
  },

  "esc-then-prompt-b": async (probe) => {
    const ready = await probe.waitForStatus("idle", 25000);
    if (!ready.reached) { probe.record("never_ready"); return; }

    probe.sendPrompt("Count from 1 to 100, one number per line");
    const busy = await probe.waitForStatus("busy", 10000);
    probe.record("busy_before_esc", busy);
    await delay(2000);

    probe.sendEsc();
    probe.record("esc_sent");

    const idled = await probe.waitForStatus("idle", 10000);
    probe.record("idle_after_esc", idled);

    if (idled.reached) {
      probe.sendPrompt("Say exactly: PROMPT_B_RECEIVED");
      probe.record("prompt_b_sent");

      const gotB = await probe.waitForOutput(/PROMPT_B_RECEIVED/i, 30000);
      probe.record("prompt_b_result", { received: gotB });
    }
  },

  "esc-immediate-prompt-b": async (probe) => {
    const ready = await probe.waitForStatus("idle", 25000);
    if (!ready.reached) { probe.record("never_ready"); return; }

    probe.sendPrompt("Count from 1 to 100, one number per line");
    const busy = await probe.waitForStatus("busy", 10000);
    probe.record("busy_before_esc", busy);
    await delay(2000);

    probe.sendEsc();
    probe.sendPrompt("Say exactly: IMMEDIATE_B");
    probe.record("esc_and_prompt_b_sent_back_to_back");

    const gotB = await probe.waitForOutput(/IMMEDIATE_B/i, 30000);
    probe.record("immediate_b_result", { received: gotB });

    const finalStatus = probe.currentStatus();
    probe.record("final_status", { status: finalStatus?.status });
  },

  "ctrl-c-behavior": async (probe) => {
    const ready = await probe.waitForStatus("idle", 25000);
    if (!ready.reached) { probe.record("never_ready"); return; }

    probe.sendPrompt("Count from 1 to 100, one number per line");
    const busy = await probe.waitForStatus("busy", 10000);
    probe.record("busy_before_ctrl_c", busy);
    await delay(2000);

    probe.sendCtrlC();
    probe.record("ctrl_c_sent");

    await delay(3000);
    const finalStatus = probe.currentStatus();
    probe.record("post_ctrl_c", { exited: probe.exited, status: finalStatus?.status });
  },

  "sigint-behavior": async (probe) => {
    const ready = await probe.waitForStatus("idle", 25000);
    if (!ready.reached) { probe.record("never_ready"); return; }

    probe.sendPrompt("Count from 1 to 100, one number per line");
    const busy = await probe.waitForStatus("busy", 10000);
    probe.record("busy_before_sigint", busy);
    await delay(2000);

    probe.kill("SIGINT");
    probe.record("sigint_sent");

    await delay(3000);
    const finalStatus = probe.currentStatus();
    probe.record("post_sigint", { exited: probe.exited, status: finalStatus?.status });
  },

  "esc-vs-ctrl-c-vs-sigint": async (probe) => {
    const ready = await probe.waitForStatus("idle", 25000);
    if (!ready.reached) { probe.record("never_ready"); return; }

    // Phase 1: ESC
    probe.sendPrompt("Write a 500 word essay about software testing");
    await probe.waitForStatus("busy", 10000);
    await delay(1500);

    probe.sendEsc();
    probe.record("esc_sent");
    const idled = await probe.waitForStatus("idle", 10000);
    probe.record("idle_after_esc", idled);

    if (!probe.exited && idled.reached) {
      // Phase 2: Ctrl-C
      probe.sendPrompt("Now count from 1 to 50, one per line");
      await probe.waitForStatus("busy", 10000);
      await delay(1500);

      probe.sendCtrlC();
      probe.record("ctrl_c_sent");
      await delay(3000);
      probe.record("after_ctrl_c", { exited: probe.exited, status: probe.currentStatus()?.status });
    }
  },
};

// ---- Runner ----

async function runProbe(name, scenario, claudeCmd, outDir, runIndex) {
  const probe = new PtyProbe(claudeCmd, root);
  const runDir = resolve(outDir, `${name}-run${runIndex}`);
  await mkdir(runDir, { recursive: true });

  process.stderr.write(`  [${name}] run ${runIndex}: starting...\n`);
  probe.start();

  try {
    await scenario(probe);
  } catch (err) {
    probe.record("scenario_error", { message: err.message });
  }

  await probe.destroy();

  const summary = probe.getSummary();
  summary.name = name;
  summary.runIndex = runIndex;

  await writeFile(join(runDir, "timeline.jsonl"), probe.timeline.map(e => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(runDir, "status-log.jsonl"), probe.statusLog.map(e => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(runDir, "raw-output.txt"), probe.rawOutput);
  await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  process.stderr.write(`  [${name}] run ${runIndex}: ${probe.exitInfo ? `exit=${probe.exitInfo.exitCode}` : "killed"}, statuses: [${probe.statusLog.map(s => s.status).join(" → ")}]\n`);
  return summary;
}

async function main() {
  const runs = Number(argValue("--runs", "3"));
  const claudeCmd = argValue("--claude", "claude");
  const outDir = resolve(argValue("--out", `.parity-runs/pty-probe-${new Date().toISOString().replaceAll(":", "-")}`));
  const scenarioFilter = argValue("--scenario");
  await mkdir(outDir, { recursive: true });

  const scenarios = scenarioFilter
    ? Object.fromEntries(Object.entries(SCENARIOS).filter(([k]) => k.includes(scenarioFilter)))
    : SCENARIOS;

  if (Object.keys(scenarios).length === 0) {
    process.stderr.write(`No scenarios matching "${scenarioFilter}"\n`);
    process.exit(1);
  }

  const allResults = {};

  for (const [name, scenario] of Object.entries(scenarios)) {
    process.stderr.write(`\nScenario: ${name}\n`);
    const results = [];
    for (let i = 1; i <= runs; i++) {
      const result = await runProbe(name, scenario, claudeCmd, outDir, i);
      results.push(result);
      await delay(2000);
    }

    allResults[name] = {
      runs: results.length,
      summaries: results.map(r => ({
        runIndex: r.runIndex,
        pid: r.pid,
        exitInfo: r.exitInfo,
        statusTransitions: r.statusLog.map(s => `${s.t}ms → ${s.status}`),
        timelineActions: r.timeline
          .filter(e => e.action !== "write" && e.action !== "pid_status")
          .map(e => `${e.t}ms ${e.action}${e.status ? ` (${e.status})` : ""}${e.label ? ` (${e.label})` : ""}`),
      })),
    };
  }

  const report = {
    claude_cmd: claudeCmd,
    runs_per_scenario: runs,
    out_dir: outDir,
    scenarios: allResults,
  };

  try {
    const { execSync } = await import("node:child_process");
    report.claude_version = execSync(`${claudeCmd} --version 2>/dev/null`, { encoding: "utf8" }).trim();
  } catch {}

  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch(err => {
  process.stderr.write(`pty-interrupt-probe error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
