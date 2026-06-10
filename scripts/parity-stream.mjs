#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROMPTS = [
  "answer in one word: ok",
  "say the word blue",
  "reply with exactly: ready",
  "what is 2+2? answer with just the number",
  "write one short sentence about testing",
  "return a JSON object with key status and value ok",
  "ask me one clarifying question about a software bug",
  "summarize this phrase in two words: request routing diagnostics",
  "say YES if you can read this",
  "respond with exactly three comma-separated colors",
  "what model are you? answer briefly",
  "write a five-word title for this chat",
  "give one shell command that lists files",
  "say no tools needed",
  "return only lowercase letters: HELLO",
  "write a single markdown bullet",
  "answer with a haiku about logs",
  "give one possible test name for a proxy filter",
  "say complete",
  "final prompt: answer done",
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function loadPrompts() {
  const file = argValue("--prompts");
  const limit = Number(argValue("--limit", "20"));
  if (!file) return DEFAULT_PROMPTS.slice(0, limit);
  const text = await readFile(resolve(file), "utf8");
  const parsed = file.endsWith(".json") ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
    throw new Error("--prompts must point to a JSON string array or newline-delimited text file");
  }
  return parsed.slice(0, limit);
}

async function loadCases(defaultPrompts) {
  const file = argValue("--cases");
  const defaultArgs = parseCommand(argValue("--extra-args", ""));
  if (!file) return [{ name: "default", args: defaultArgs, prompts: defaultPrompts }];

  const text = await readFile(resolve(file), "utf8");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("--cases must point to a JSON array");

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`case ${index} must be an object`);
    }
    const name = typeof item.name === "string" && item.name ? item.name : `case-${index + 1}`;
    const args = item.args === undefined ? [] : item.args;
    if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) {
      throw new Error(`case ${name} args must be a string array`);
    }
    // replaceArgs: use the case args verbatim instead of appending to the
    // common stream-json args — needed for text/json output-format captures.
    const replaceArgs = item.replaceArgs === true;

    const cwd = typeof item.cwd === "string" ? item.cwd : undefined;

    if (item.sequence) {
      if (!Array.isArray(item.sequence)) throw new Error(`case ${name} sequence must be an array`);
      return { name, args, replaceArgs, cwd, sequence: item.sequence };
    }

    const prompts = item.prompts === undefined ? defaultPrompts : item.prompts;
    if (!Array.isArray(prompts) || !prompts.every(prompt => typeof prompt === "string")) {
      throw new Error(`case ${name} prompts must be a string array`);
    }
    return { name, args, replaceArgs, cwd, prompts };
  });
}

function parseCommand(command) {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map(part => part.replace(/^["']|["']$/g, ""));
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "case";
}

function writeUserMessage(stdin, content) {
  stdin.write(JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  }) + "\n");
}

let nextControlRequestId = 0;

function writeControlRequest(stdin, subtype, extra = {}) {
  stdin.write(JSON.stringify({
    type: "control_request",
    request_id: `parity-${++nextControlRequestId}`,
    request: { subtype, ...extra },
  }) + "\n");
}

// Answers a can_use_tool control_request the way an SDK client would
// (shape matches src/__fixtures__/claude-p-control-requests-all.jsonl).
function writeControlResponse(stdin, request, behavior, message) {
  const toolUseID = request?.request?.tool_use_id;
  const inner = behavior === "allow"
    ? { behavior: "allow", toolUseID, updatedInput: request?.request?.input }
    : { behavior: "deny", message: message ?? "Denied by parity harness", toolUseID };
  stdin.write(JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: request?.request_id, response: inner },
  }) + "\n");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSession({ name, command, args, prompts, sequence, outDir, env = {}, cwd = root }) {
  if (!command) throw new Error(`Missing command for ${name}`);
  const stdoutPath = resolve(outDir, `${name}.stdout.jsonl`);
  const stderrPath = resolve(outDir, `${name}.stderr.log`);
  const timelinePath = resolve(outDir, `${name}.timeline.jsonl`);
  const parsed = [];
  const timeline = [];
  const stderr = [];
  const controlRequests = [];
  let answeredControlRequests = 0;
  let stdout = "";
  let sent = 0;
  let results = 0;
  let settled = false;
  const startedAt = Date.now();

  const recordTimeline = (action, detail = {}) => {
    timeline.push({ t: Date.now() - startedAt, action, ...detail });
  };

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  const exitPromise = new Promise(resolveExit => {
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });

  const isSequenceMode = Array.isArray(sequence);

  const sendNextPrompt = () => {
    if (isSequenceMode || sent >= prompts.length) {
      if (!isSequenceMode) child.stdin.end();
      return;
    }
    const content = prompts[sent++];
    recordTimeline("send_prompt", { index: sent - 1, content });
    writeUserMessage(child.stdin, content);
  };

  const timeoutMs = Number(argValue("--timeout-ms", "180000"));
  const timer = setTimeout(() => {
    if (!settled) {
      recordTimeline("timeout_kill");
      child.kill("SIGTERM");
    }
  }, timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    let idx = stdout.indexOf("\n");
    while (idx >= 0) {
      const line = stdout.slice(0, idx);
      stdout = stdout.slice(idx + 1);
      if (line.trim()) {
        try {
          const obj = JSON.parse(line);
          parsed.push(obj);
          recordTimeline("event", { type: obj.type, subtype: obj.subtype });
          if (obj.type === "control_request") {
            controlRequests.push(obj);
            recordTimeline("control_request_received", { subtype: obj.request?.subtype, request_id: obj.request_id });
          }
          if (obj.type === "result") {
            results++;
            recordTimeline("result", { subtype: obj.subtype, exit_code: obj.exit_code });
            if (!isSequenceMode) sendNextPrompt();
          }
        } catch {
          parsed.push({ type: "non_json_stdout", line });
        }
      }
      idx = stdout.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => stderr.push(chunk));

  if (isSequenceMode) {
    recordTimeline("sequence_start", { steps: sequence.length });
    try {
      for (const step of sequence) {
        if (settled) break;
        if (step.delayMs) {
          recordTimeline("delay_start", { ms: step.delayMs });
          await delay(step.delayMs);
          recordTimeline("delay_end");
        }
        if (step.type === "user") {
          sent++;
          recordTimeline("send_prompt", { index: sent - 1, content: step.content });
          writeUserMessage(child.stdin, step.content);
        } else if (step.type === "control_request") {
          recordTimeline("send_control", { subtype: step.subtype });
          writeControlRequest(child.stdin, step.subtype, step.request ?? {});
        } else if (step.type === "wait_control_request") {
          recordTimeline("wait_control_request_start");
          const waitMs = step.timeoutMs ?? 30_000;
          await new Promise((resolve) => {
            const check = () => {
              if (controlRequests.length > answeredControlRequests || settled) { clearInterval(interval); resolve(); }
            };
            const interval = setInterval(check, 50);
            setTimeout(() => { clearInterval(interval); resolve(); }, waitMs);
            check();
          });
          recordTimeline("wait_control_request_end", { received: controlRequests.length });
        } else if (step.type === "control_response") {
          const pending = controlRequests[answeredControlRequests];
          if (pending) {
            answeredControlRequests++;
            recordTimeline("send_control_response", { behavior: step.behavior, request_id: pending.request_id });
            writeControlResponse(child.stdin, pending, step.behavior ?? "allow", step.message);
          } else {
            recordTimeline("control_response_skipped_no_pending_request");
          }
        } else if (step.type === "signal") {
          recordTimeline("send_signal", { signal: step.signal });
          child.kill(step.signal);
        } else if (step.type === "wait_result") {
          recordTimeline("wait_result_start");
          const waitMs = step.timeoutMs ?? 30_000;
          await new Promise((resolve) => {
            const resultCount = results;
            const check = () => {
              if (results > resultCount || settled) { clearInterval(interval); resolve(); }
            };
            const interval = setInterval(check, 50);
            setTimeout(() => { clearInterval(interval); resolve(); }, waitMs);
            check();
          });
          recordTimeline("wait_result_end", { results });
        } else if (step.type === "close_stdin") {
          recordTimeline("close_stdin");
          child.stdin.end();
        }
      }
    } finally {
      if (!settled) {
        recordTimeline("sequence_done_closing_stdin");
        child.stdin.end();
      }
    }
  } else {
    sendNextPrompt();
  }

  const exit = await exitPromise;
  settled = true;
  clearTimeout(timer);
  recordTimeline("exit", exit);

  await writeFile(stdoutPath, parsed.map(obj => JSON.stringify(obj)).join("\n") + (parsed.length ? "\n" : ""));
  await writeFile(stderrPath, stderr.join(""));
  await writeFile(timelinePath, timeline.map(obj => JSON.stringify(obj)).join("\n") + (timeline.length ? "\n" : ""));

  return { name, exit, sent, results, stdoutPath, stderrPath, events: parsed, timeline };
}

function assistantText(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("");
}

function summarize(run) {
  const assistants = run.events.filter(event => event.type === "assistant").map(assistantText);
  const results = run.events.filter(event => event.type === "result").map(event => event.result ?? "");
  const systems = run.events
    .filter(event => event.type === "system")
    .map(event => event.subtype ?? "unknown");
  const eventCounts = countBy(run.events.map(eventKey));
  const nonAssistantCounts = Object.fromEntries(
    Object.entries(eventCounts).filter(([key]) => !key.startsWith("assistant") && !key.startsWith("result")),
  );
  return {
    exit: run.exit,
    sent: run.sent,
    results_seen: run.results,
    assistant_count: assistants.length,
    result_count: results.length,
    event_counts: eventCounts,
    non_assistant_counts: nonAssistantCounts,
    system_subtypes: [...new Set(systems)].sort(),
    suspicious_assistant_texts: assistants.filter(text => /^\s*\{/.test(text) || /"title"\s*:/.test(text)),
  };
}

function diffSummaries(nativeSummary, clarpSummary) {
  return {
    assistant_count_delta: clarpSummary.assistant_count - nativeSummary.assistant_count,
    result_count_delta: clarpSummary.result_count - nativeSummary.result_count,
    event_count_delta: diffCounts(nativeSummary.event_counts, clarpSummary.event_counts),
    non_assistant_count_delta: diffCounts(nativeSummary.non_assistant_counts, clarpSummary.non_assistant_counts),
    clarp_extra_system_subtypes: clarpSummary.system_subtypes.filter(subtype => !nativeSummary.system_subtypes.includes(subtype)),
    clarp_suspicious_assistant_texts: clarpSummary.suspicious_assistant_texts,
  };
}

function eventKey(event) {
  if (!event || typeof event !== "object") return "unknown";
  return event.subtype ? `${event.type}.${event.subtype}` : String(event.type ?? "unknown");
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function diffCounts(nativeCounts, clarpCounts) {
  const keys = [...new Set([...Object.keys(nativeCounts), ...Object.keys(clarpCounts)])].sort();
  return Object.fromEntries(
    keys
      .map(key => [key, (clarpCounts[key] ?? 0) - (nativeCounts[key] ?? 0)])
      .filter(([, delta]) => delta !== 0),
  );
}

async function main() {
  const prompts = await loadPrompts();
  const cases = await loadCases(prompts);
  const outDir = resolve(argValue("--out", `.parity-runs/${new Date().toISOString().replaceAll(":", "-")}`));
  await mkdir(outDir, { recursive: true });

  const model = argValue("--model", "sonnet");
  const nativeCmd = parseCommand(argValue("--native", "claude"));
  const clarpDefault = `${process.execPath} ${resolve(root, "dist", "cli.js")}`;
  const clarpCmd = parseCommand(argValue("--clarp", clarpDefault));
  const commonArgs = ["-p", "--model", model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];

  const nativeVersion = await new Promise(resolveVersion => {
    try {
      const probe = spawn(nativeCmd[0], [...nativeCmd.slice(1), "--version"]);
      let out = "";
      probe.stdout.on("data", chunk => { out += chunk; });
      probe.on("exit", () => resolveVersion(out.trim() || "unknown"));
      probe.on("error", () => resolveVersion("unknown"));
    } catch {
      resolveVersion("unknown");
    }
  });

  // --native-replay <dir>: instead of spawning the native CLI (metered after
  // 2026-06-15), load its recorded summaries from a prior --native-only golden
  // capture and diff a fresh clarp run against them.
  const replayDir = argValue("--native-replay");
  let replayReport = null;
  if (replayDir) {
    replayReport = JSON.parse(await readFile(resolve(replayDir, "report.json"), "utf8"));
  }

  const report = {
    model,
    captured_at: new Date().toISOString(),
    native_version: replayDir ? `replay:${replayReport.native_version ?? "unknown"}` : nativeVersion,
    out_dir: outDir,
    ...(replayDir ? { replay_from: resolve(replayDir) } : {}),
    cases: {},
  };

  for (const testCase of cases) {
    const caseDir = cases.length === 1 ? outDir : resolve(outDir, safeName(testCase.name));
    await mkdir(caseDir, { recursive: true });
    const args = testCase.replaceArgs ? [...testCase.args] : [...commonArgs, ...testCase.args];
    const sessionOpts = testCase.sequence
      ? { sequence: testCase.sequence }
      : { prompts: testCase.prompts };
    if (testCase.cwd) {
      const caseCwd = resolve(root, testCase.cwd);
      await mkdir(caseCwd, { recursive: true });
      sessionOpts.cwd = caseCwd;
    }
    const runs = [];
    let replayedNativeSummary = null;
    if (replayDir) {
      const savedCase = replayReport.cases?.[testCase.name];
      if (savedCase?.runs?.native) {
        replayedNativeSummary = savedCase.runs.native;
      } else {
        process.stderr.write(`warning: no saved native run for case ${testCase.name} in ${replayDir}\n`);
      }
    } else if (!hasArg("--clarp-only")) {
      runs.push(await runSession({
        name: "native",
        command: nativeCmd[0],
        args: [...nativeCmd.slice(1), ...args],
        ...sessionOpts,
        outDir: caseDir,
      }));
    }
    if (!hasArg("--native-only")) {
      runs.push(await runSession({
        name: "clarp",
        command: clarpCmd[0],
        args: [...clarpCmd.slice(1), ...args],
        ...sessionOpts,
        outDir: caseDir,
        env: { CLARP_DEBUG_API: "1" },
      }));
    }

    const promptsSent = testCase.sequence
      ? testCase.sequence.filter(s => s.type === "user").length
      : testCase.prompts.length;
    const caseReport = {
      args: testCase.args,
      prompts_sent: promptsSent,
      mode: testCase.sequence ? "sequence" : "prompts",
      out_dir: caseDir,
      runs: Object.fromEntries(runs.map(run => [run.name, summarize(run)])),
    };
    if (replayedNativeSummary) {
      caseReport.runs.native = replayedNativeSummary;
    }
    if (runs.length > 0 && runs[0].timeline) {
      caseReport.timelines = Object.fromEntries(runs.map(run => [run.name, run.timeline ?? []]));
    }
    if (caseReport.runs.native && caseReport.runs.clarp) {
      caseReport.diff = diffSummaries(caseReport.runs.native, caseReport.runs.clarp);
    }
    report.cases[testCase.name] = caseReport;
  }

  if (cases.length === 1) {
    const only = report.cases[cases[0].name];
    report.prompts_sent = only.prompts_sent;
    report.runs = only.runs;
    if (only.diff) report.diff = only.diff;
  }

  await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch(err => {
  process.stderr.write(`parity-stream error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
