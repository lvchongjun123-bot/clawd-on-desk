"use strict";

// ── Windows fullscreen application detector ──
//
// Compiles a tiny native C# Win32 console daemon (once), spawns it as a
// persistent background process, and reads "True\n"/"False\n" lines from
// stdout every ~100 ms.  The daemon polls GetForegroundWindow() internally
// so no per-tick process creation → no foreground-stealing.
//
// macOS is a no-op: Clawd already uses visibleOnFullScreen + collection behavior.
//
// Public API:
//   createFullscreenDetector({ pollIntervalMs, scriptDir, onStateChange })
//     → { start(), stop(), getState(), onStateChange(fn) }

const { execSync, spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── C# daemon source ──
// Continuously polls GetForegroundWindow() → checks if fullscreen
// (excluding desktop shell windows Progman / WorkerW).
const CS_SOURCE = [
  'using System;using System.Runtime.InteropServices;using System.Text;using System.Threading;',
  'class FSC{',
  '[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);',
  '[DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT r);',
  '[DllImport("user32.dll")]static extern IntPtr MonitorFromWindow(IntPtr h,uint f);',
  '[DllImport("user32.dll")]static extern bool GetMonitorInfo(IntPtr m,ref MONITORINFO i);',
  'struct RECT{public int L,T,R,B;}',
  'struct MONITORINFO{public int S;public RECT M,W;public uint F;}',
  'const uint MDT=2;',
  'static bool IsFullscreen(){',
  'var h=GetForegroundWindow();if(h==IntPtr.Zero)return false;',
  'var sb=new StringBuilder(256);GetClassName(h,sb,256);',
  'string cn=sb.ToString();if(cn=="Progman"||cn=="WorkerW")return false;',
  'var mi=new MONITORINFO{S=Marshal.SizeOf(typeof(MONITORINFO))};',
  'var m=MonitorFromWindow(h,MDT);if(m==IntPtr.Zero||!GetMonitorInfo(m,ref mi))return false;',
  'RECT r;if(!GetWindowRect(h,out r))return false;',
  'return r.L<=mi.M.L+8&&r.T<=mi.M.T+8&&r.R>=mi.M.R-8&&r.B>=mi.M.B-60;',
  '}',
  'static int Main(){',
  'while(true){',
  'Console.WriteLine(IsFullscreen()?"True":"False");',
  'Console.Out.Flush();',
  'Thread.Sleep(100);',
  '}',
  '}',
  '}',
].join('\n');

// PowerShell variant kept as fallback (Base64 encoded, no escaping issues).
const PS_SCRIPT = [
  '$ProgressPreference="SilentlyContinue"',
  '$c=@\'',
  'using System;using System.Runtime.InteropServices;using System.Text;',
  'public class FSD{',
  '[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder s,int n);',
  '[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);',
  '[DllImport("user32.dll")]public static extern IntPtr MonitorFromWindow(IntPtr h,uint f);',
  '[DllImport("user32.dll")]public static extern bool GetMonitorInfo(IntPtr m,ref MONITORINFO i);',
  'public struct RECT{public int L,T,R,B;}',
  'public struct MONITORINFO{public int S;public RECT M,W;public uint F;}',
  'public const uint MDT=2;',
  'public static bool Chk(){',
  'var h=GetForegroundWindow();if(h==IntPtr.Zero)return false;',
  'var sb=new StringBuilder(256);GetClassName(h,sb,256);',
  'string cn=sb.ToString();if(cn=="Progman"||cn=="WorkerW")return false;',
  'var mi=new MONITORINFO{S=Marshal.SizeOf(typeof(MONITORINFO))};',
  'var m=MonitorFromWindow(h,MDT);if(m==IntPtr.Zero||!GetMonitorInfo(m,ref mi))return false;',
  'RECT r;if(!GetWindowRect(h,out r))return false;',
  'return r.L<=mi.M.L+8&&r.T<=mi.M.T+8&&r.R>=mi.M.R-8&&r.B>=mi.M.B-60;',
  '}',
  '}',
  '\'@',
  'Add-Type $c',
  '[FSD]::Chk()',
  '',
].join('\r\n');

// ── Helpers ──

function encodeForPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// ── Exe compilation ──

const CSC_PATH = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";

function compileExe(scriptDir) {
  if (!scriptDir) return null;
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
  } catch (_) { return null; }

  const csPath = path.join(scriptDir, "clawd-fs-check.cs");
  const exePath = path.join(scriptDir, "clawd-fs-check.exe");

  if (!fs.existsSync(CSC_PATH)) return null;

  // Write current source and compile fresh (fast, ~200ms)
  try {
    fs.writeFileSync(csPath, CS_SOURCE, "utf8");
    const result = spawnSync(CSC_PATH, [
      "/nologo",
      "/target:exe",
      `/out:${exePath}`,
      "/reference:System.dll",
      csPath,
    ], { timeout: 10000, windowsHide: true, encoding: "utf8" });
    if (result.status !== 0 || result.error) {
      try { fs.unlinkSync(exePath); } catch (_) {}
      return null;
    }
    return exePath;
  } catch (_) {
    try { fs.unlinkSync(exePath); } catch (_) {}
    return null;
  }
}

// ── One-shot check (exported for ad-hoc use & testing) ──

function isForegroundFullscreen(deps) {
  const _execSync = (deps && deps.execSync) || execSync;
  const script = (deps && deps.script) || PS_SCRIPT;
  try {
    const encoded = encodeForPowerShell(script);
    const out = _execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: 4000, windowsHide: true, encoding: "utf8" },
    );
    return out.trim() === "True";
  } catch (_) {
    return false;
  }
}

// ── Polling detector (daemon-based) ──

function createFullscreenDetector(options) {
  if (typeof options !== "object" || !options) options = {};

  const {
    pollIntervalMs = 100,
    onStateChange: initialListener = null,
    scriptDir = null,
    isWin = process.platform === "win32",
  } = options;

  // Non-Windows → no-op detector
  if (!isWin) {
    return {
      start: () => {},
      stop: () => {},
      getState: () => false,
      onStateChange: () => () => {},
    };
  }

  let daemonProc = null;   // spawned daemon process (fast path)
  let psEncoded = null;    // slow path: PowerShell base64 (compiled once)
  let timer = null;        // used only for PowerShell slow path
  let running = false;
  let reportedState = false;

  const listeners = new Set();
  if (typeof initialListener === "function") listeners.add(initialListener);

  function fireStateChange(state) {
    if (reportedState === state) return;
    reportedState = state;
    for (const fn of listeners) {
      try { fn(state); } catch (_) { /* don't let one listener break others */ }
    }
  }

  // PowerShell slow path: one-shot execSync every pollIntervalMs
  function tickPs() {
    if (!running) return;
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${psEncoded}`,
        { timeout: 4000, windowsHide: true, encoding: "utf8" },
      );
      const isFullscreen = out.trim() === "True";
      fireStateChange(isFullscreen);
    } catch (_) {
      // silently ignore
    }
  }

  function startDaemon(exePath) {
    const proc = spawn(exePath, [], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let buf = "";
    proc.stdout.on("data", (data) => {
      if (!running) return;
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const t = line.trim();
        if (t === "True" || t === "False") {
          fireStateChange(t === "True");
        }
      }
    });

    proc.on("error", () => {
      // Daemon died unexpectedly — fall back to PowerShell
      daemonProc = null;
      if (running) {
        psEncoded = encodeForPowerShell(PS_SCRIPT);
        tickPs();
        timer = setInterval(tickPs, pollIntervalMs);
      }
    });

    proc.on("close", () => {
      daemonProc = null;
    });

    daemonProc = proc;
  }

  function start() {
    if (!isWin) return;
    stop();
    running = true;
    reportedState = false;

    // Try to compile native daemon for fast path
    const exePath = compileExe(scriptDir);
    if (exePath) {
      startDaemon(exePath);
    } else {
      // Fallback: PowerShell slow path
      psEncoded = encodeForPowerShell(PS_SCRIPT);
      tickPs();
      timer = setInterval(tickPs, pollIntervalMs);
    }
  }

  function stop() {
    running = false;
    if (daemonProc) {
      try { daemonProc.kill(); } catch (_) {}
      daemonProc = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getState() {
    return reportedState;
  }

  function onStateChange(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  return { start, stop, getState, onStateChange };
}

module.exports = { createFullscreenDetector, isForegroundFullscreen };
