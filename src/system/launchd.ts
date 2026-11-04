import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLIError } from "../utils/errors.js";
import { exec } from "../utils/exec.js";
import { logFile } from "./state.js";

const LABEL = "com.crafterstation.awake.autooff";
const LAUNCHCTL = "/bin/launchctl";
const BOOTSTRAP_ATTEMPTS = 15;
const BOOTSTRAP_RETRY_MS = 200;

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildPlist(): string {
  // Re-run the exact same runtime + entrypoint that scheduled this job,
  // so it works for `bun run` in dev and the built dist alike.
  const runtime = process.execPath;
  const entry = resolve(process.argv[1] ?? "");
  const log = logFile();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(runtime)}</string>
    <string>${xmlEscape(entry)}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function uid(): number {
  return process.getuid?.() ?? 501;
}

export async function startWatcher(): Promise<void> {
  const path = plistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, buildPlist());

  await exec(LAUNCHCTL, ["bootout", `gui/${uid()}/${LABEL}`], {
    allowFailure: true,
  });

  // bootout returns before a running watcher has exited, and bootstrap fails
  // until it has, so give it a moment when replacing a live hold.
  let code = 1;
  for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS && code !== 0; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_RETRY_MS));
    }
    const result = await exec(LAUNCHCTL, ["bootstrap", `gui/${uid()}`, path], {
      allowFailure: true,
    });
    code = result.code;
  }
  if (code !== 0) {
    throw new CLIError(
      `Could not start the hold watcher (launchctl exited ${code}).`,
      { code: "launchd_failed", hint: "try again" },
    );
  }
}

// Remove the plist BEFORE bootout: when this runs inside the launchd job
// itself (the watcher), bootout kills our own process instantly - anything
// after it never executes. Callers must treat stopWatcher() as a
// potential point of no return and do their cleanup first.
export async function stopWatcher(): Promise<void> {
  rmSync(plistPath(), { force: true });
  await exec(LAUNCHCTL, ["bootout", `gui/${uid()}/${LABEL}`], {
    allowFailure: true,
  });
}
