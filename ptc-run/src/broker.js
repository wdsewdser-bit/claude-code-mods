"use strict";
// ptc-run read-only broker. Started by the hook instead of the runner when PTC_RUN_READONLY=1.
// It launches the runner under the Node permission model (reads only in the session cwd, the scope dir and its own
// response dir; writes only in the session scope dir;
// no child processes / workers / addons) and runs ripgrep on its behalf. The restricted runner asks for an rg run by
// writing <reqDir>/<id>.req; the broker validates the argv against a strict whitelist, runs the bundled rg and writes
// <resDir>/<id>.out + <id>.res. reqDir lives in the writable scope dir (user code can forge requests there, so the
// whitelist is the hard boundary); resDir is outside it, so the restricted process can only read the answers.
// Input (line 1 of stdin, via the bootstrap): {cwd, code, rg, scope, dsh, maxChars, timeoutMs, root, roRoots, logName, boot, runner}.
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const input = JSON.parse(typeof globalThis.__PTC_IN === "string" ? globalThis.__PTC_IN : fs.readFileSync(0, "utf8"));
const runnerSrc = input.runner, boot = input.boot;
delete input.runner; delete input.boot;
let cwd = input.cwd || process.cwd();
const NL = "\n";
const started = Date.now();
const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.min(Math.max(input.timeoutMs, 1000), 1800000) : 300000;
const deadline = started + Math.max(500, timeoutMs - 1500); // a little earlier than the hook's own timeout
const rand = () => crypto.randomBytes(6).toString("hex");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const fail = (msg, code) => { process.stdout.write("run_code (read-only) failed: " + msg, () => process.exit(code || 1)); };

(function main() {

if (typeof runnerSrc !== "string" || typeof boot !== "string") { fail("broker input is missing the runner"); return; }
// Optional root: an existing absolute directory. It becomes the session cwd for the runner, rg validation and reads.
if (input.root !== undefined) {
  if (typeof input.root !== "string" || input.root === "" || !path.isAbsolute(input.root)) { fail("root must be an absolute path: " + String(input.root)); return; }
  let st; try { st = fs.statSync(input.root); } catch (e) { fail(e.code === "ENOENT" ? "root not found: " + input.root : "cannot read root: " + String(e.message || e)); return; }
  if (!st.isDirectory()) { fail("root is not a directory: " + input.root); return; }
  // Read-only scope: root may only narrow the session cwd, never widen it (checked lexically and after resolving links).
  const within = (p, base) => { const r = path.relative(base.toLowerCase(), p.toLowerCase()); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const want = path.resolve(input.root);
  // Besides the session cwd, the hook may name extra trusted roots (PTC_RUN_RO_ROOTS); never from user code.
  const bases = [cwd, ...(Array.isArray(input.roRoots) ? input.roRoots.filter((b) => typeof b === "string" && path.isAbsolute(b)) : [])];
  if (!bases.some((b) => within(want, path.resolve(b)) && within(real(want), real(b)))) { fail("[POLICY_DENIED] read-only root must be inside the session cwd: " + input.root); return; }
  cwd = want;
}
// rg comes from the broker's own input, never from a request
const RG = typeof input.rg === "string" && input.rg && fs.existsSync(input.rg) ? input.rg : null;

// ---------- state dirs ----------
const scope = (String(input.scope || "default").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 80)) || "default";
const stateDir = path.join(os.tmpdir(), "cc-ptc", scope);
const resRoot = path.join(os.tmpdir(), "cc-ptc-ro");
fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
fs.mkdirSync(resRoot, { recursive: true });
const tag = process.pid + "-" + rand();
const reqDir = path.join(stateDir, "ro-req-" + tag);
const resDir = path.join(resRoot, tag);
fs.mkdirSync(reqDir);
fs.mkdirSync(resDir);

// Remove a directory this broker created, without following links: one level of plain files / links only.
const cleanDir = (d) => {
  let st; try { st = fs.lstatSync(d); } catch { return; }
  if (!st.isDirectory()) { try { fs.unlinkSync(d); } catch {} return; } // replaced by a link / junction: drop the link itself
  let names = []; try { names = fs.readdirSync(d); } catch {}
  for (const n of names) {
    const p = path.join(d, n);
    try { const s = fs.lstatSync(p); if (s.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); } catch {}
  }
  try { fs.rmdirSync(d); } catch {}
};
// sweep leftovers of brokers that were killed before they could clean up (their pid is gone)
const sweep = (root, re) => {
  let names = []; try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names) { const m = re.exec(n); if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) cleanDir(path.join(root, n)); }
};
sweep(stateDir, /^ro-req-(\d+)-[0-9a-f]+$/);
sweep(resRoot, /^(\d+)-[0-9a-f]+$/);
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; cleanDir(reqDir); cleanDir(resDir); };
process.on("exit", cleanup);

// ---------- rg argv whitelist ----------
// Exactly the tokens the runner generates. No combined short flags, no --flag=value forms, no "--".
const FLAG0 = new Set(["--files", "--null", "-l", "-c", "-H", "--json", "-U", "-P", "-i", "--hidden", "--no-ignore"]);
const ANY = () => true, NUM = (v) => /^\d{1,6}$/.test(v);
const FLAG1 = new Map([["-g", ANY], ["-e", ANY], ["--max-filesize", (v) => v === "2M"], ["-B", NUM], ["-A", NUM]]);
const DENY = new Set(["--pre", "--pre-glob", "-z", "--search-zip", "--hostname-bin"]);
const isAbsPath = (p) => (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/?.]/.test(p) || (process.platform !== "win32" && p.startsWith("/")));
// Search roots must stay inside the session cwd (lexically and after resolving links); the restricted runner may only
// read there too, but the broker runs rg unrestricted, so it enforces this itself.
const WINP = process.platform === "win32";
const key = (p) => { const r = path.resolve(p); return WINP ? r.toLowerCase() : r; };
const insideOf = (p, root) => { const a = key(p), r = key(root); return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
let cwdReal = cwd; try { cwdReal = fs.realpathSync.native(cwd); } catch {}
const inCwd = (p) => {
  if (!insideOf(p, cwd) && !insideOf(p, cwdReal)) return false;
  let real = null; try { real = fs.realpathSync.native(p); } catch { return true; } // missing path: rg finds nothing
  return insideOf(real, cwdReal) || insideOf(real, cwd);
};
const validate = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 4096) return "argv must be a non-empty array (<= 4096 items)";
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string") return "argv[" + i + "] is not a string";
    if (a.includes("\0")) return "argv[" + i + "] contains NUL";
    if (DENY.has(a) || DENY.has(a.split("=")[0])) return "option refused: " + a;
    if (FLAG0.has(a)) continue;
    if (FLAG1.has(a)) {
      if (i + 1 >= argv.length) return "option " + a + " needs a value";
      const v = argv[i + 1];
      if (typeof v !== "string" || v.includes("\0") || !FLAG1.get(a)(v)) return "bad value for " + a;
      i++; continue;
    }
    if (a.startsWith("-")) return "option not allowed: " + a;
    if (!isAbsPath(a)) return "positional argument must be an absolute path: " + a;
    if (!inCwd(a)) return "search path is outside the session cwd (read-only mode reads only the working directory): " + a;
    positional++;
  }
  if (!positional) return "a search path is required";
  return null;
};
const rgEnv = (() => { const e = Object.assign({}, process.env); for (const k of Object.keys(e)) if (/^RIPGREP_CONFIG_PATH$/i.test(k)) delete e[k]; return e; })();

// ---------- request handling ----------
const writeAtomic = (f, data) => {
  const t = path.join(resDir, "." + rand() + ".tmp");
  fs.writeFileSync(t, data, { flag: "wx" });
  fs.renameSync(t, f);
};
const done = new Set();
const handle = (name) => {
  const id = name.slice(0, -4);
  done.add(name);
  const reply = (res, out) => {
    if (out !== undefined) writeAtomic(path.join(resDir, id + ".out"), out);
    writeAtomic(path.join(resDir, id + ".res"), JSON.stringify(res));
  };
  let req;
  try {
    const f = path.join(reqDir, name), st = fs.lstatSync(f);
    if (!st.isFile() || st.size > (8 << 20)) return reply({ error: "INVALID_ARGUMENT", message: "bad request file" });
    req = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) { return reply({ error: "INVALID_ARGUMENT", message: "unreadable request: " + String(e.message || e).slice(0, 200) }); }
  if (!req || typeof req !== "object") return reply({ error: "INVALID_ARGUMENT", message: "request must be an object" });
  if (req.cwd !== cwd) return reply({ error: "POLICY_DENIED", message: "request cwd does not match the session cwd" });
  const why = validate(req.argv);
  if (why) return reply({ error: "POLICY_DENIED", message: "rg request refused by the read-only broker: " + why });
  if (!RG) return reply({ error: "RG_UNAVAILABLE", message: "bundled rg not found" });
  const left = deadline - Date.now();
  if (left <= 0) return reply({ error: "OUTPUT_LIMIT", message: "rg not started: run_code deadline reached" });
  const r = cp.spawnSync(RG, ["--no-config", ...req.argv], { cwd, env: rgEnv, maxBuffer: 1024 << 20, timeout: Math.min(300000, left), windowsHide: true });
  const out = r.stdout || Buffer.alloc(0);
  reply({ status: r.status, stderr: String(r.stderr || "").slice(0, 64 << 10), errorCode: r.error ? r.error.code || "ERROR" : null }, out);
};
const scan = () => {
  let names;
  try {
    const st = fs.lstatSync(reqDir);
    if (!st.isDirectory()) return; // tampered with (replaced by a link): stop serving
    names = fs.readdirSync(reqDir);
  } catch { return; }
  for (const n of names.sort()) {
    if (done.has(n) || !/^[A-Za-z0-9_-]{1,80}\.req$/.test(n)) continue;
    try { handle(n); } catch (e) { try { writeAtomic(path.join(resDir, n.slice(0, -4) + ".res"), JSON.stringify({ error: "RESULT_UNKNOWN", message: "broker error: " + String(e.message || e).slice(0, 200) })); } catch {} }
  }
};

// ---------- restricted runner ----------
const childInput = Object.assign({}, input, { readonly: true, reqDir, resDir, stateDir, brokerPid: process.pid });
// Reads: the session cwd (as given, its real path and both drive-letter cases, since the permission model compares
// paths case-sensitively), the scope dir (refs) and this broker's response dir. Writes: the scope dir only.
const readRoots = [];
const addRead = (p) => { if (p && !readRoots.includes(p)) readRoots.push(p); };
for (const p of [cwd, cwdReal]) { addRead(p); if (WINP && /^[A-Za-z]:/.test(p)) { addRead(p[0].toUpperCase() + p.slice(1)); addRead(p[0].toLowerCase() + p.slice(1)); } }
addRead(stateDir); addRead(resDir);
const args = ["--permission", ...readRoots.map((p) => "--allow-fs-read=" + p), "--allow-fs-write=" + stateDir, "-e", boot];
let child;
try { child = cp.spawn(process.execPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
catch (e) { fail("cannot start the restricted runner: " + String(e.message || e)); return; }
const outB = [], errB = [];
child.stdout.on("data", (d) => outB.push(d));
child.stderr.on("data", (d) => errB.push(d));
child.stdin.on("error", () => {});
child.stdin.end(JSON.stringify(childInput) + NL + runnerSrc);
let watcher = null;
try { watcher = fs.watch(reqDir, () => scan()); watcher.on("error", () => {}); } catch {}
const poll = setInterval(scan, 5);
let timedOut = false;
const killer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, Math.max(1, deadline - Date.now()));
child.on("error", (e) => errB.push(Buffer.from("[broker] " + String(e.message || e))));
child.on("close", (code) => {
  clearInterval(poll); clearTimeout(killer); if (watcher) try { watcher.close(); } catch {}
  cleanup();
  let out = Buffer.concat(outB).toString("utf8");
  const err = Buffer.concat(errB).toString("utf8");
  if (timedOut) out += (out ? NL : "") + "[TIMEOUT] run_code (read-only) was killed after " + (Date.now() - started) + " ms (timeoutMs " + timeoutMs + "). Read-only mode: no project files were changed. Narrow the work or raise timeoutMs.";
  if (err) process.stderr.write(err);
  process.stdout.write(out, () => process.exit(timedOut ? 124 : code === null ? 1 : code));
});
})();
