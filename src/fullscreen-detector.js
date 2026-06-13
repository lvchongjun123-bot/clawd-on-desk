"use strict";

// ── Windows fullscreen application detector ──
//
// Compiles a tiny native C# Win32 console exe (once), then polls it with
// Node's execFileSync (no shell).  Native startup + P/Invoke ≈ 20-40 ms
// versus 400-600 ms for the PowerShell + Add-Type path.
//
// macOS is a no-op: Clawd already uses visibleOnFullScreen + collection behavior.
//
// Public API:
//   createFullscreenDetector({ pollIntervalMs, scriptDir, onStateChange })
//     → { start(), stop(), getState(), onStateChange(fn) }

const { execFileSync, execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── C# source (compact, single file, no external refs beyond System.dll) ──
const CS_SOURCE = [
  'using System;using System.Runtime.InteropServices;',
  'class FSC{',
  '[DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT r);',
  '[DllImport("user32.dll")]static extern IntPtr MonitorFromWindow(IntPtr h,uint f);',
  '[DllImport("user32.dll")]static extern bool GetMonitorInfo(IntPtr m,ref MONITORINFO i);',
  'struct RECT{public int L,T,R,B;}',
  'struct MONITORINFO{public int S;public RECT M,W;public uint F;}',
  'const uint MDT=2;',
  'static int Main(){',
  'var h=GetForegroundWindow();if(h==IntPtr.Zero){Console.WriteLine("False");return 0;}',
  'var mi=new MONITORINFO{S=Marshal.SizeOf(typeof(MONITORINFO))};',
  'var m=MonitorFromWindow(h,MDT);if(m==IntPtr.Zero||!GetMonitorInfo(m,ref mi)){Console.WriteLine("False");return 0;}',
  'RECT r;if(!GetWindowRect(h,out r)){Console.WriteLine("False");return 0;}',
  'bool f=r.L<=mi.M.L+8&&r.T<=mi.M.T+8&&r.R>=mi.M.R-8&&r.B>=mi.M.B-60;',
  'Console.WriteLine(f?"True":"False");return 0;',
  '}',
  '}',
].join('\n');

// PowerShell variant kept as fallback (Base64 encoded, no escaping issues).
const PS_SCRIPT = [
  '$ProgressPreference="SilentlyContinue"',
  '$c=@\'',
  'using System;using System.Runtime.InteropServices;',
  'public class FSD{',
  '[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);',
  '[DllImport("user32.dll")]public static extern IntPtr MonitorFromWindow(IntPtr h,uint f);',
  '[DllImport("user32.dll")]public static extern bool GetMonitorInfo(IntPtr m,ref MONITORINFO i);',
  'public struct RECT{public int L,T,R,B;}',
  'public struct MONITORINFO{public int S;public RECT M,W;public uint F;}',
  'public const uint MDT=2;',
  'public static bool Chk(){',
  'var h=GetForegroundWindow();if(h==IntPtr.Zero)return false;',
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
  const cscExists = fs.existsSync(CSC_PATH);

  if (!cscExists) return null;

  // If a working exe already exists, use it directly (skip recompilation)
  if (fs.existsSync(exePath)) {
    try {
      const out = execFileSync(exePath, [], { timeout: 3000, windowsHide: true, encoding: "utf8" });
      if (out.trim() === "True" || out.trim() === "False") return exePath;
    } catch (_) { /* exe broken, recompile below */ }
  }

  // Compile fresh
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
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
    // Quick smoke test
    const out = execFileSync(exePath, [], { timeout: 3000, windowsHide: true, encoding: "utf8" });
    if (out.trim() === "True" || out.trim() === "False") return exePath;
    try { fs.unlinkSync(exePath); } catch (_) {}
  } catch (_) {
    try { fs.unlinkSync(exePath); } catch (_) {}
  }
  return null;
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

// ── Polling detector ──

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

  let timer = null;
  let running = false;
  let reportedState = false;
  let exePath = null;        // fast path: compiled native exe
  let psEncoded = null;      // slow path: PowerShell base64 (compiled once)

  const listeners = new Set();
  if (typeof initialListener === "function") listeners.add(initialListener);

  function fireStateChange(state) {
    if (reportedState === state) return; // no change
    reportedState = state;
    for (const fn of listeners) {
      try { fn(state); } catch (_) { /* don't let one listener break others */ }
    }
  }

  function checkSync() {
    try {
      let out;
      if (exePath) {
        // Fast path: native exe, no shell overhead (~30-40ms)
        out = execFileSync(exePath, [], { timeout: 2000, windowsHide: true, encoding: "utf8" });
      } else if (psEncoded) {
        out = execSync(
          `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${psEncoded}`,
          { timeout: 4000, windowsHide: true, encoding: "utf8" },
        );
      } else {
        return false;
      }
      return out.trim() === "True";
    } catch (_) {
      return false;
    }
  }

  function tick() {
    if (!running) return;
    const isFullscreen = checkSync();
    fireStateChange(isFullscreen);
  }

  function start() {
    if (!isWin) return;
    stop();
    running = true;
    reportedState = false;

    // Try to compile native exe for fast path (one-time)
    exePath = compileExe(scriptDir);
    if (!exePath) {
      // Fallback: pre-encode PowerShell script so we don't encode each tick
      psEncoded = encodeForPowerShell(PS_SCRIPT);
    }

    // Immediate first check
    tick();
    timer = setInterval(tick, pollIntervalMs);
  }

  function stop() {
    running = false;
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
