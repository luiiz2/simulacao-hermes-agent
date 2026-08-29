// ComputerActionService — direct gateway-level Windows actions with safety
// levels. LEVEL 1 runs immediately; LEVEL 3 requires a single-use, expiring,
// user-bound confirmation token.
//
// Note: the OpenCode agent itself can already control the computer through its
// own tools inside the active workspace. This service covers fast slash
// commands and explicitly dangerous machine-wide actions.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execP = promisify(execFile);
const TOKEN_TTL_MS = 5 * 60 * 1000;

export const LEVEL = { SAFE: 1, MODIFY: 2, SENSITIVE: 3 };

const APP_MAP = {
  notepad: "notepad", bloco: "notepad", "bloco de notas": "notepad",
  calc: "calc", calculadora: "calc",
  explorer: "explorer", explorador: "explorer",
  vscode: "code", code: "code", "vs code": "code",
  paint: "mspaint", cmd: "cmd", powershell: "powershell",
};

export class ComputerActions {
  constructor(log) {
    this.log = log;
    this.pending = new Map(); // token -> {userId, desc, fn, exp}
    setInterval(() => this._sweep(), 60_000).unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [t, p] of this.pending) if (p.exp < now) this.pending.delete(t);
  }

  // Returns {ok:true} or {confirm:<token>, desc} for sensitive actions.
  async run(userId, action, args = []) {
    const level = classify(action);
    if (level === LEVEL.SENSITIVE) {
      const token = String(randomInt(100000, 999999));
      const fns = ACTIONS[action];
      this.pending.set(token, {
        userId, action, args, exp: Date.now() + TOKEN_TTL_MS,
        fn: () => fns.exec(args, this.log),
      });
      this.log("info", "confirm_requested", { userId, action });
      return { confirm: token, desc: fns.desc(...args) };
    }
    return { ok: true, result: await ACTIONS[action].exec(args, this.log) };
  }

  async confirm(userId, token) {
    const p = this.pending.get(token);
    if (!p) return { error: "Código inválido ou expirado." };
    if (String(p.userId) !== String(userId)) return { error: "Código não pertence a este usuário." };
    this.pending.delete(token); // single use, after ownership check
    if (p.exp < Date.now()) return { error: "Código expirado." };
    const result = await p.fn();
    return { ok: true, result };
  }
}

export function classify(action) {
  if (["shutdown", "restart"].includes(action)) return LEVEL.SENSITIVE;
  return action === "url" ? LEVEL.MODIFY : LEVEL.SAFE;
}

async function ps(script, log, timeout = 30000) {
  const t0 = Date.now();
  const r = await execP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  log?.("info", "computer_exec", { ms: Date.now() - t0, script: script.slice(0, 80) });
  return (r.stdout || "").trim();
}

export const ACTIONS = {
  sys: {
    desc: () => "Inspecionar sistema (CPU/RAM/disco)",
    exec: async (_a, log) => ps(`
$c = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average;
$os = Get-CimInstance Win32_OperatingSystem;
$ramU = [math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1);
$ramT = [math]::Round($os.TotalVisibleMemorySize/1MB,1);
$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";
$df = [math]::Round($d.FreeSpace/1GB,0); $dt = [math]::Round($d.Size/1GB,0);
$up = (Get-Date) - $os.LastBootUpTime;
"CPU: $c%"
"RAM: $ramU/$ramT GB"
"Disco C: $df GB livres de $dt GB"
"Uptime: $($up.Days)d $($up.Hours)h $($up.Minutes)m"
`, log),
  },
  ps_list: {
    desc: () => "Listar processos por uso de memória",
    exec: async (_a, log) => ps(`Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name,@{n='RAM_MB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String`, log),
  },
  open: {
    desc: (app) => `Abrir ${app}`,
    exec: async ([app], log) => {
      const target = APP_MAP[String(app).toLowerCase()];
      if (!target) throw new Error(`App desconhecido: ${app}. Conhecidos: ${Object.keys(APP_MAP).join(", ")}`);
      await ps(`Start-Process '${target}'`, log);
      return `${app} aberto.`;
    },
  },
  url: {
    desc: (u) => `Abrir URL ${u}`,
    exec: async ([u], log) => {
      if (!/^https?:\/\//i.test(u)) throw new Error("URL deve começar com http:// ou https://");
      await ps(`Start-Process '${u.replace(/'/g, "")}'`, log);
      return "URL aberta no navegador.";
    },
  },
  shot: {
    desc: () => "Captura de tela",
    exec: async (_a, log) => {
      const file = join(tmpdir(), `shot-${Date.now()}.png`);
      await ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$b = New-Object System.Drawing.Bitmap([System.Windows.Forms.SystemInformation]::VirtualScreen.Width, [System.Windows.Forms.SystemInformation]::VirtualScreen.Height);
$g = [System.Drawing.Graphics]::FromImage($b);
$g.CopyFromScreen(0,0,0,0,$b.Size);
$b.Save('${file.replace(/\\/g, "/")}',[System.Drawing.Imaging.ImageFormat]::Png);`, log, 45000);
      return { screenshotPath: file };
    },
  },
  shutdown: {
    desc: () => "DESLIGAR o computador",
    exec: async (_a, log) => { spawn("shutdown.exe", ["/s", "/t", "30"], { windowsHide: true }); log?.("warn", "shutdown_issued"); return "Windows desligará em 30s."; },
  },
  restart: {
    desc: () => "REINICIAR o computador",
    exec: async (_a, log) => { spawn("shutdown.exe", ["/r", "/t", "30"], { windowsHide: true }); log?.("warn", "restart_issued"); return "Windows reiniciará em 30s."; },
  },
};
