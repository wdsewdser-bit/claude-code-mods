"use strict";
// ptc-run sandbox runner. CommonJS, node built-ins only. Input (stdin JSON): {cwd, code, rg, scope, maxChars}.
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
// Launched by a tiny bootstrap (the full source exceeds the Windows 32K command-line limit): the bootstrap
// puts the input JSON in globalThis.__PTC_IN and evals this file. Falls back to stdin when run directly.
const input = JSON.parse(typeof globalThis.__PTC_IN === "string" ? globalThis.__PTC_IN : fs.readFileSync(0, "utf8"));
const cwd = input.cwd || process.cwd();
const MAX = input.maxChars || 6000;
const NL = "\n";
const WIN = process.platform === "win32";

// ---------- structured errors ----------
class PtcError extends Error {
  constructor(code, msg, nextAction, extra) {
    super("[" + code + "] " + msg);
    this.name = "PtcError"; this.code = code; this.nextAction = nextAction || "";
    if (extra) for (const k of Object.keys(extra)) if (k !== "message") this[k] = extra[k];
  }
}
const E = (code, msg, next, extra) => new PtcError(code, msg, next, extra);
const SYS = {
  ENOENT: ["NOT_FOUND", "Check the path with tools.glob; paths are relative to cwd."],
  ENOTDIR: ["NOT_FOUND", "A path component is not a directory; check the path."],
  EEXIST: ["EXISTS", "The target already exists; choose another name or remove it first."],
  EACCES: ["POLICY_DENIED", "Permission denied by the OS; check file permissions / locks."],
  EPERM: ["POLICY_DENIED", "Operation not permitted by the OS; check permissions / read-only attribute / locks."],
  EROFS: ["POLICY_DENIED", "Read-only file system."],
  EBUSY: ["BUSY", "File is in use by another process; release it, then retry (tools.batch resume for batch jobs)."],
  EISDIR: ["INVALID_ARGUMENT", "The path is a directory; pass a file path."],
  EINVAL: ["INVALID_ARGUMENT", "Invalid argument for this operation."],
  ENAMETOOLONG: ["INVALID_ARGUMENT", "Path is too long."],
};
const sysErr = (e) => {
  if (e instanceof PtcError) return e;
  // BUSY: EBUSY / sharing-violation text. On Windows a lock can also surface as EPERM/EACCES, so those are classified
  // by classifyPerm (read-only attribute, deny ACE, no write permission => POLICY_DENIED; otherwise BUSY).
  const busy = e && (e.code === "EBUSY" || /sharing violation|being used by another process/i.test(String(e.message || "")));
  let m = busy ? SYS.EBUSY : e && SYS[e.code], note = "";
  if (!busy && e && (e.code === "EPERM" || e.code === "EACCES") && WIN && typeof e.path === "string") {
    let c = null; try { c = classifyPerm(e); } catch {}
    if (c) { m = c.code === "BUSY" ? SYS.EBUSY : SYS[e.code]; note = c.note; }
  }
  if (!m) return e;
  const x = E(m[0], String(e.message || e.code) + note, m[1], { sys: e.code || "EBUSY" });
  if (e.effect) x.effect = e.effect;
  return x;
};
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// short backoff for transient EPERM/EACCES (antivirus / indexer locks): 60+120+180 ms = 360 ms at most
const withRetry = (fn) => {
  const waits = [60, 120, 180];
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) { if (i >= waits.length || !(e && (e.code === "EPERM" || e.code === "EACCES"))) throw e; sleepSync(waits[i]); }
  }
};
// icacls: is there an explicit DENY ACE for the current user / Everyone / Users on p?
const hasDenyAce = (p) => {
  const r = cp.spawnSync("icacls.exe", [p], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (r.error || r.status !== 0) return false;
  const me = String(os.userInfo().username || "").toLowerCase();
  return String(r.stdout).toLowerCase().split("\n").some((l) => /\(deny\)/.test(l) && (l.includes(me + ":(deny)") || /(everyone|users):\(deny\)/.test(l)));
};
// Decide whether an EPERM/EACCES on a Windows path is a lock (BUSY) or a real permission problem (POLICY_DENIED).
const classifyPerm = (e) => {
  const p = e.path;
  let st; try { st = fs.lstatSync(p); } catch { return null; }
  const denied = (why) => ({ code: "POLICY_DENIED", note: " (permission denied: " + why + ")" });
  if (st.isFile() && (st.mode & 0o200) === 0) return denied("read-only attribute is set");
  const parents = [path.dirname(p)]; if (typeof e.dest === "string") parents.push(path.dirname(e.dest));
  for (const q of [p, ...parents]) if (hasDenyAce(q)) return denied("explicit deny ACE on " + q);
  for (const d of parents) {
    const probe = path.join(d, ".ptc-probe-" + process.pid + "-" + crypto.randomBytes(3).toString("hex"));
    try { fs.closeSync(fs.openSync(probe, "wx")); } catch (er) { if (er.code === "EPERM" || er.code === "EACCES") return denied("cannot create files in " + d); continue; }
    try { fs.unlinkSync(probe); } catch { return denied("cannot delete in " + d + " (probe file " + probe + " left behind)"); }
  }
  if (st.isFile()) {
    try { fs.closeSync(fs.openSync(p, "r+")); } catch (er) {
      if (er.code === "EBUSY" || /sharing violation|being used by another process/i.test(String(er.message))) return { code: "BUSY", note: " (in use by another process: sharing violation on open; raw " + e.code + ")" };
      if (er.code === "EPERM" || er.code === "EACCES") return denied("file cannot be opened for writing");
    }
  }
  return { code: "BUSY", note: " (inferred in use by another process (" + e.code + "): no read-only attribute, deny ACE or missing write permission found)" };
};
const guard = (fn) => (...a) => { try { return fn(...a); } catch (e) { throw sysErr(e); } };
const A = (a, name) => { if (a === null || typeof a !== "object" || Array.isArray(a)) throw E("INVALID_ARGUMENT", (name || "tool") + " expects one object argument", "Pass an options object, e.g. tools.x({path: 'a.txt'})."); return a; };
const reqStr = (v, name) => { if (typeof v !== "string" || v === "") throw E("INVALID_ARGUMENT", name + " must be a non-empty string", "Fix the '" + name + "' argument."); return v; };
const optInt = (v, name, def, min, max) => {
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw E("INVALID_ARGUMENT", name + " must be an integer in [" + min + ", " + max + "]", "Fix the '" + name + "' argument.");
  return v;
};

// ---------- state dirs (per session scope) ----------
const scope = (String(input.scope || "default").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 80)) || "default";
const dir = path.join(os.tmpdir(), "cc-ptc", scope);
const jobsDir = path.join(dir, "jobs");
fs.mkdirSync(jobsDir, { recursive: true });
try { // sweep refs older than 24h in this scope (jobs are kept)
  const cut = Date.now() - 24 * 3600 * 1000;
  for (const n of fs.readdirSync(dir)) {
    if (!/\.(json|tmp)$/.test(n)) continue;
    const p = path.join(dir, n);
    try { const st = fs.lstatSync(p); if (st.isFile() && st.mtimeMs < cut) fs.unlinkSync(p); } catch {}
  }
} catch {}

const abs = (p) => path.resolve(cwd, p);
const rel = (f) => { const r = path.relative(cwd, f).split(path.sep).join("/"); return r.startsWith("..") || path.isAbsolute(r) ? f.split(path.sep).join("/") : r; };
const lines = [];
const fmt = (v) => typeof v === "string" ? v : JSON.stringify(v, null, 1);
const logf = (...a) => lines.push(a.map(fmt).join(" "));
const cons = { log: logf, error: logf, warn: logf, info: logf };
const readState = {};

// ---------- atomic write ----------
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const renameRetry = (a, b) => {
  for (let i = 0; ; i++) {
    try { fs.renameSync(a, b); return; } catch (e) {
      if (i >= 5 || !(e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY")) throw e;
      sleepMs(20 * (i + 1));
    }
  }
};
const tmpName = (f) => path.join(path.dirname(f), "." + path.basename(f) + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp");
const atomicWrite = (f, data) => {
  let target = f, mode;
  let l = null;
  try { l = fs.lstatSync(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (l) {
    if (l.isSymbolicLink()) target = fs.realpathSync(f);
    const st = fs.statSync(target);
    if (st.isDirectory()) throw E("INVALID_ARGUMENT", "path is a directory: " + rel(f), "Pass a file path.");
    mode = st.mode & 0o777;
  }
  const t = tmpName(target);
  try {
    fs.writeFileSync(t, data, { flag: "wx" });
    if (mode !== undefined && !WIN) fs.chmodSync(t, mode);
    renameRetry(t, target);
  } catch (e) { try { fs.unlinkSync(t); } catch {} throw e; }
};

// ---------- credential guard: OFF by default, enabled with env PTC_DENY_CREDENTIALS=1 (tools.bash is never restricted) ----------
const CRED_ON = process.env.PTC_DENY_CREDENTIALS === "1";
const CRED_PRE = /\.(env|pem|key|ssh|aws|gnupg|docker|npmrc|netrc|git-credentials|config|claude)|id_rsa|id_ed25519/;
const CRED_DIRS = [".ssh", ".aws", ".gnupg"];
const CRED_FILES = [".docker/config.json", ".npmrc", ".netrc", ".git-credentials", ".config/gh/hosts.yml", ".claude/.credentials.json"];
const ENV_OK = [".env.example", ".env.sample", ".env.template"];
const normSegs = (a) => String(a).replace(/^\\\\\?\\/, "").split(/[\\/]+/).filter(Boolean).map((s, i) => {
  s = s.toLowerCase();
  if (i === 0 && /^[a-z]:$/.test(s)) return s;
  s = s.replace(/:.*$/, ""); // NTFS alternate data stream suffix
  if (!/^\.+$/.test(s)) s = s.replace(/[. ]+$/, ""); // Windows ignores trailing dots / spaces
  return s;
});
const HOMES = (() => {
  const out = [];
  for (let h of [os.homedir(), process.env.USERPROFILE, process.env.HOME]) {
    if (!h) continue;
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(h); if (m && WIN) h = m[1] + ":/" + m[2]; // git-bash style /c/Users/x
    const s = normSegs(h); if (s.length && !out.some((o) => o.join("/") === s.join("/"))) out.push(s);
  }
  return out;
})();
const credStr = (a) => {
  if (!CRED_ON) return false;
  const raw = String(a).toLowerCase();
  if (!CRED_PRE.test(raw)) return false;
  const segs = normSegs(a), b = segs[segs.length - 1] || "";
  if (b === ".env" || (b.startsWith(".env.") && !ENV_OK.includes(b))) return true;
  if (b.endsWith(".pem") || b.endsWith(".key") || b.startsWith("id_rsa") || b.startsWith("id_ed25519")) return true;
  for (const h of HOMES) {
    if (segs.length <= h.length || !h.every((x, i) => segs[i] === x)) continue;
    const rest = segs.slice(h.length);
    if (CRED_DIRS.includes(rest[0])) return true;
    if (CRED_FILES.includes(rest.join("/"))) return true;
  }
  return false;
};
// fast filter for paths returned by rg (no symlink resolution; rg does not follow links)
const credFast = (p) => credStr(path.resolve(cwd, p));
// full check for a caller-supplied path: lexical (.., slashes, case) and real path (symlinks, 8.3 short names)
const credBlocked = (p) => {
  if (!CRED_ON) return null;
  const a = path.resolve(cwd, p);
  if (credStr(a)) return a;
  try { const r = fs.realpathSync.native(a); if (credStr(r)) return r; } catch {
    try { const r = path.join(fs.realpathSync.native(path.dirname(a)), path.basename(a)); if (credStr(r)) return r; } catch {}
  }
  return null;
};
const credGuard = (p) => {
  if (typeof p !== "string" || p === "") return;
  const hit = credBlocked(p);
  if (hit) throw E("POLICY_DENIED", "credential path refused: " + rel(hit), "Credential files (.ssh, .aws, .env, *.pem, *.key, ...) are not readable through these tools; ask the user for the specific non-secret value instead.");
};

// ---------- tools: read / write / edit / bash ----------
const tools = {};
tools.read = ({ path: p, offset = 0, limit } = {}) => {
  reqStr(p, "path"); credGuard(p);
  const f = abs(p), t = fs.readFileSync(f, "utf8");
  readState[f] = fs.statSync(f).mtimeMs;
  if (!offset && limit === undefined) return t;
  const ls = t.split(NL);
  if (ls.length > 1 && ls[ls.length - 1] === "") ls.pop(); // a trailing newline terminates the last line, it does not start another
  return ls.slice(offset, limit === undefined ? undefined : offset + limit).join(NL);
};
tools.write = (a) => {
  A(a, "write"); reqStr(a.path, "path");
  if (typeof a.content !== "string") throw E("INVALID_ARGUMENT", "content must be a string", "Pass content as a string.");
  const f = abs(a.path);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  atomicWrite(f, a.content);
  try { readState[f] = fs.statSync(f).mtimeMs; } catch {}
  return { bytes: Buffer.byteLength(a.content) };
};
tools.edit = (a) => {
  A(a, "edit"); reqStr(a.path, "path");
  const { path: p, old, new: nw, all = false } = a;
  if (typeof old !== "string" || old === "") throw E("INVALID_ARGUMENT", "old must be a non-empty string", "Pass the exact text to replace.");
  if (typeof nw !== "string") throw E("INVALID_ARGUMENT", "new must be a string", "Pass the replacement text.");
  const f = abs(p);
  let st;
  try { st = fs.statSync(f); } catch (e) { if (e.code === "ENOENT") throw E("NOT_FOUND", "file not found: " + p, "Check the path with tools.glob."); throw e; }
  if (readState[f] !== undefined && st.mtimeMs !== readState[f]) throw E("STALE", "file changed since it was read: " + p, "Re-read the file with tools.read and redo the edit.");
  const t = fs.readFileSync(f, "utf8");
  const n = t.split(old).length - 1;
  if (n === 0) throw E("NOT_FOUND", "old string not found in " + p, "Re-read the file and copy the exact text (whitespace and line endings matter).");
  if (n > 1 && !all) throw E("NOT_UNIQUE", "old string matches " + n + " places in " + p, "Add surrounding context to make it unique, or pass all:true.");
  atomicWrite(f, all ? t.split(old).join(nw) : t.replace(old, () => nw));
  readState[f] = fs.statSync(f).mtimeMs;
  return { replaced: all ? n : 1 };
};
tools.bash = (a) => {
  A(a, "bash"); reqStr(a.command, "command");
  const { command, cwd: c, timeoutMs = 120000 } = a;
  const o = { cwd: c ? abs(c) : cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 << 20 };
  let r = cp.spawnSync("bash", ["-c", command], o);
  if (r.error && r.error.code === "ENOENT") r = cp.spawnSync(command, Object.assign({ shell: true }, o));
  if (r.error && r.error.code === "ENOBUFS") throw E("OUTPUT_LIMIT", "command output exceeded 256MB", "Redirect output to a file or filter it in the command.");
  if (r.error && r.error.code === "ETIMEDOUT") return { code: null, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: true };
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

// ---------- tools.parallel: concurrent bash (async spawn) ----------
const WD = "(" + (function () { // watchdog: when the runner dies (pipe EOF) kill every still-registered child tree
  const cp = require("child_process"), pids = new Set(); let b = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); const [c, p] = l.split(" "); if (c === "add") pids.add(p); else if (c === "del") pids.delete(p); } });
  process.stdin.on("end", () => {
    for (const p of pids) { try { if (process.platform === "win32") cp.spawnSync("taskkill", ["/pid", p, "/T", "/F"], { windowsHide: true }); else process.kill(-Number(p), "SIGKILL"); } catch {} }
    process.exit(0);
  });
}).toString() + ")()";
let wd = null;
const wdSend = (line) => {
  try {
    if (!wd) { wd = cp.spawn(process.execPath, ["-e", WD], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: true }); wd.unref(); wd.stdin.on("error", () => {}); }
    wd.stdin.write(line + "\n");
  } catch {}
};
const killTree = (child) => {
  try { if (WIN) cp.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch {} }
};
const PAR_MAX_BUF = 256 << 20;
const runOne = (s) => new Promise((resolve) => {
  const outB = [], errB = []; let nOut = 0, nErr = 0, timedOut = false, over = false, settled = false, child = null, fallback = false, force = null;
  const finish = (code) => {
    if (settled) return; settled = true; clearTimeout(timer); clearTimeout(force);
    if (child && child.pid) wdSend("del " + child.pid);
    const r = { code: timedOut || over ? null : code, stdout: Buffer.concat(outB).toString("utf8"), stderr: Buffer.concat(errB).toString("utf8") };
    if (timedOut) r.timedOut = true;
    if (over) r.error = "[OUTPUT_LIMIT] command output exceeded 256MB and was killed";
    resolve(r);
  };
  const start = (useShell) => {
    child = useShell ? cp.spawn(s.command, { shell: true, cwd: s.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : cp.spawn("bash", ["-c", s.command], { cwd: s.cwd, windowsHide: true, detached: !WIN, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) wdSend("add " + child.pid);
    child.stdout.on("data", (d) => { if (over) return; nOut += d.length; if (nOut > PAR_MAX_BUF) { over = true; killTree(child); } else outB.push(d); });
    child.stderr.on("data", (d) => { if (over) return; nErr += d.length; if (nErr > PAR_MAX_BUF) { over = true; killTree(child); } else errB.push(d); });
    child.on("error", (e) => {
      if (e && e.code === "ENOENT" && !useShell && !fallback) { fallback = true; start(true); return; }
      errB.push(Buffer.from(String((e && e.message) || e))); finish(null);
    });
    child.on("close", (code) => finish(code));
  };
  const timer = setTimeout(() => { timedOut = true; if (child) { killTree(child); force = setTimeout(() => finish(null), 2000); } else finish(null); }, s.timeoutMs);
  start(false);
});
tools.parallel = (calls, opts) => {
  if (!Array.isArray(calls) || !calls.length) throw E("INVALID_ARGUMENT", "calls must be a non-empty array of {command,cwd?,timeoutMs?}", "Pass tools.parallel([{command:'...'}, ...]).");
  if (calls.length > 64) throw E("INVALID_ARGUMENT", "at most 64 calls per parallel (got " + calls.length + ")", "Split into several parallel calls.");
  const o = opts === undefined || opts === null ? {} : A(opts, "parallel options");
  const conc = optInt(o.concurrency, "concurrency", 4, 1, 16);
  const specs = calls.map((c, i) => {
    A(c, "parallel call " + i); reqStr(c.command, "command");
    const timeoutMs = optInt(c.timeoutMs, "timeoutMs", 120000, 1, 3600000);
    let cd = cwd;
    if (c.cwd !== undefined && c.cwd !== null) {
      cd = abs(reqStr(c.cwd, "cwd"));
      let st; try { st = fs.statSync(cd); } catch { throw E("NOT_FOUND", "cwd not found for call " + i + ": " + c.cwd, "Check the cwd of that call."); }
      if (!st.isDirectory()) throw E("INVALID_ARGUMENT", "cwd of call " + i + " is not a directory", "Check the cwd of that call.");
    }
    return { command: c.command, cwd: cd, timeoutMs };
  });
  return new Promise((resolve) => {
    const results = new Array(specs.length); let next = 0, active = 0, done = 0;
    const pump = () => {
      while (active < conc && next < specs.length) {
        const i = next++; active++;
        runOne(specs[i]).then((r) => { results[i] = r; active--; done++; if (done === specs.length) resolve(results); else pump(); });
      }
    };
    pump();
  });
};

// ---------- ripgrep ----------
const SKIP = ["!node_modules", "!target", "!.venv", "!.git", "!.dsh-ops"];
let rgCache;
const rgPath = () => {
  if (rgCache) return rgCache;
  if (input.rg && fs.existsSync(input.rg)) return (rgCache = input.rg);
  const names = WIN ? ["rg.exe"] : ["rg"];
  for (const d of String(process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    if (!d) continue;
    for (const n of names) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return (rgCache = p); } catch {} }
  }
  throw E("RG_UNAVAILABLE", "ripgrep (rg) was not found at the bundled path or on PATH", "Install ripgrep and put it on PATH, or use tools.bash with another search command.");
};
const globArgs = (g) => [].concat(g || []).flatMap((x) => ["-g", x]).concat(SKIP.flatMap((x) => ["-g", x]));
const runRg = (args, rootAbs, soft) => { // soft: return null instead of throwing when rg rejects the pattern
  if (soft) {
    if (rootAbs !== undefined && !fs.existsSync(rootAbs)) throw E("NOT_FOUND", "search path not found: " + rel(rootAbs), "Check the 'path' argument.");
    const s = cp.spawnSync(rgPath(), args, { cwd, encoding: "utf8", maxBuffer: 1024 << 20, timeout: 300000 });
    if (s.error) { if (s.error.code === "ENOENT") throw E("RG_UNAVAILABLE", "cannot execute rg", "Install ripgrep and put it on PATH."); throw E("OUTPUT_LIMIT", "rg failed: " + s.error.code, "Narrow 'path' or 'glob'."); }
    return s.status === 2 && !s.stdout ? null : (s.stdout || "");
  }
  if (rootAbs !== undefined && !fs.existsSync(rootAbs)) throw E("NOT_FOUND", "search path not found: " + rel(rootAbs), "Check the 'path' argument.");
  const r = cp.spawnSync(rgPath(), args, { cwd, encoding: "utf8", maxBuffer: 1024 << 20, timeout: 300000 });
  if (r.error) {
    if (r.error.code === "ENOENT") throw E("RG_UNAVAILABLE", "cannot execute rg", "Install ripgrep and put it on PATH.");
    throw E("OUTPUT_LIMIT", "rg failed: " + r.error.code, "Narrow 'path' or 'glob'.");
  }
  if (r.status === 2 && /regex|parse error|error parsing|unclosed|unrecognized|unopened/i.test(r.stderr || "")) {
    throw E("INVALID_ARGUMENT", "invalid pattern: " + String(r.stderr).split(NL).filter(Boolean).slice(0, 3).join(" | ").slice(0, 400), "Fix the regex (Rust regex syntax: no lookaround/backreferences).");
  }
  return r.stdout || "";
};
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const paginate = (all, offset, limit) => {
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  const more = next < all.length;
  return { items, total: all.length, complete: !more, nextOffset: more ? next : null };
};
const pathOf = (o) => o.text !== undefined ? o.text : Buffer.from(o.bytes, "base64").toString("utf8");
const CRLF_END = /\r?\n$/;

tools.glob = guard((a = {}) => {
  A(a, "glob");
  const { pattern, path: root, sort = "path", details = false } = a;
  if (sort !== "path" && sort !== "modified") throw E("INVALID_ARGUMENT", "sort must be 'path' or 'modified'", "Use sort:'path' or sort:'modified'.");
  const offset = optInt(a.offset, "offset", 0, 0, 1e9), limit = optInt(a.limit, "limit", 5000, 1, 1e6);
  credGuard(root || ".");
  const rootAbs = abs(root || ".");
  const out = runRg(["--files", "--null", ...globArgs(pattern), rootAbs], rootAbs);
  let files = out.split("\0").map((s) => s.replace(/^\r?\n/, "")).filter(Boolean).filter((f) => !credFast(f)).map((f) => rel(f));
  const st = (f) => { try { return fs.statSync(abs(f)); } catch { return null; } };
  let stats = null;
  if (sort === "modified") {
    stats = new Map(files.map((f) => [f, st(f)]));
    files.sort((x, y) => ((stats.get(y) ? stats.get(y).mtimeMs : 0) - (stats.get(x) ? stats.get(x).mtimeMs : 0)) || cmp(x, y));
  } else files.sort(cmp);
  const pg = paginate(files, offset, limit);
  if (details) pg.items = pg.items.map((f) => { const s = stats ? stats.get(f) : st(f); return { path: f, size: s ? s.size : null, mtime: s ? s.mtime.toISOString() : null }; });
  return pg;
});

tools.grep = guard((a) => {
  A(a, "grep");
  const { pattern, path: root, glob, ignoreCase = false, outputMode = "content", multiline = false } = a;
  reqStr(pattern, "pattern");
  if (!["content", "files_with_matches", "count"].includes(outputMode)) throw E("INVALID_ARGUMENT", "outputMode must be content|files_with_matches|count", "Fix outputMode.");
  const before = optInt(a.before, "before", 0, 0, 100), after = optInt(a.after, "after", 0, 0, 100);
  const offset = optInt(a.offset, "offset", 0, 0, 1e9), limit = optInt(a.limit !== undefined ? a.limit : a.max, "limit", 500, 1, 1e6);
  credGuard(root || ".");
  const rootAbs = abs(root || ".");
  const base = ["--max-filesize", "2M", ...globArgs(glob)];
  if (ignoreCase) base.push("-i");
  if (multiline) base.push("-U");
  if (outputMode === "files_with_matches") {
    const out = runRg(["-l", "--null", ...base, "-e", pattern, rootAbs], rootAbs);
    return paginate(out.split("\0").map((s) => s.replace(/^\r?\n/, "")).filter(Boolean).filter((f) => !credFast(f)).map(rel).sort(cmp), offset, limit);
  }
  if (outputMode === "count") {
    const out = runRg(["-c", "-H", "--null", ...base, "-e", pattern, rootAbs], rootAbs);
    const rows = [];
    for (const l of out.split(NL)) { const i = l.lastIndexOf("\0"); if (i < 0) continue; if (credFast(l.slice(0, i))) continue; rows.push({ file: rel(l.slice(0, i)), count: Number(l.slice(i + 1)) }); }
    rows.sort((x, y) => cmp(x.file, y.file));
    const pg = paginate(rows, offset, limit);
    pg.matchingLines = rows.reduce((s, r) => s + r.count, 0);
    return pg;
  }
  // content: consume everything, group per file, sort by file for stable paging
  const args = ["--json", ...base];
  if (before) args.push("-B", String(before));
  if (after) args.push("-A", String(after));
  args.push("-e", pattern, rootAbs);
  const out = runRg(args, rootAbs);
  const blocks = []; let cur = null, total = 0;
  for (const l of out.split(NL)) {
    if (l.startsWith('{"type":"match"')) { if (cur) { cur.rows.push(l); cur.m++; total++; } }
    else if (l.startsWith('{"type":"context"')) { if (cur) cur.rows.push(l); }
    else if (l.startsWith('{"type":"begin"')) { const pf = pathOf(JSON.parse(l).data.path); if (credFast(pf)) cur = null; else { cur = { file: rel(pf), rows: [], m: 0 }; blocks.push(cur); } }
  }
  blocks.sort((x, y) => cmp(x.file, y.file));
  const items = [];
  let idx = 0;
  const end = offset + limit;
  for (const b of blocks) {
    const lo = idx, hi = idx + b.m;
    idx = hi;
    if (hi <= offset || lo >= end) continue;
    const ent = []; const picked = []; let mi = lo;
    for (const raw of b.rows) {
      const d = JSON.parse(raw).data;
      const isMatch = raw.startsWith('{"type":"match"');
      const e = { file: b.file, line: d.line_number, text: pathOf(d.lines).replace(CRLF_END, "").slice(0, 300) };
      if (isMatch) {
        const inWin = mi >= offset && mi < end; mi++;
        if (inWin) { e.end = e.line + (pathOf(d.lines).replace(CRLF_END, "").split(NL).length - 1); picked.push(e); ent.push(e); }
      } else { e.context = true; ent.push(e); }
    }
    for (const e of ent) {
      if (e.context) {
        if (!picked.some((m) => (e.line >= m.line - before && e.line < m.line) || (e.line > m.end && e.line <= m.end + after))) continue;
      }
      items.push(e);
    }
    for (const m of picked) delete m.end;
  }
  const more = offset + limit < total;
  return { items, total, complete: !more, nextOffset: more ? offset + limit : null };
});

// loosen a JS pattern into a superset-safe pattern for the file finder
const looseForFinder = (pattern) => {
  let pat = "", inClass = false, needsPcre = false, needsScan = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const n = pattern[i + 1]; i++;
      if (n === undefined) { pat += c; break; }
      if ("WDS".includes(n)) needsScan = true;
      if (n === "k") needsPcre = true;
      if (!inClass && (n === "b" || n === "B")) continue;
      if (!inClass && n >= "1" && n <= "9") needsPcre = true;
      pat += c + n; continue;
    }
    if (inClass) { if (c === "]") inClass = false; pat += c; continue; }
    if (c === "[") { inClass = true; pat += c; continue; }
    if (c === "(" && pattern[i + 1] === "?") {
      const t = pattern.slice(i + 2, i + 4);
      if (/^[=!]/.test(t) || /^<[=!]/.test(t)) { needsPcre = true; if (t[0] === "!" || t === "<!") needsScan = true; }
    }
    if (c === "^" || c === "$") continue;
    pat += c;
  }
  return { pat, needsPcre, needsScan };
};
tools.replace = guard((a) => {
  A(a, "replace");
  const { pattern, replacement, path: root, glob, flags = "", dryRun = false } = a;
  reqStr(pattern, "pattern");
  if (typeof replacement !== "string") throw E("INVALID_ARGUMENT", "replacement must be a string", "Use JS replacement syntax ($1, $&).");
  if (typeof flags !== "string" || !/^[dgimsuvy]*$/.test(flags)) throw E("INVALID_ARGUMENT", "flags must be JS RegExp flags", "Use a subset of dgimsuvy.");
  const maxRep = optInt(a.maxReplacements, "maxReplacements", 100000, 1, 1e9);
  let re;
  try { re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g"); } catch (e) { throw E("INVALID_ARGUMENT", "invalid regex: " + e.message, "Fix the JS regular expression."); }
  // The finder must never miss a file the JS regex would hit (superset), because replacement semantics are JS's.
  // Zero-width assertions (^ $ \b \B) are dropped for the finder (a looser pattern only adds candidates); \W \D \S and
  // negative lookaround cannot be loosened safely and go to a full scan; lookaround / backrefs use PCRE2 (rg -P).
  const ls = looseForFinder(pattern);
  const inline = ["i", "m", "s"].filter((f) => flags.includes(f)).join("");
  const rgPattern = (inline ? "(?" + inline + ")" : "") + ls.pat;
  credGuard(root || ".");
  const rootAbs = abs(root || ".");
  const parse = (o) => o.split("\0").map((s) => s.replace(/^\r?\n/, "")).filter(Boolean).sort(cmp);
  let finder = "scan", files = null;
  if (!ls.needsScan) {
    const o = runRg(["-l", "--null", "-U", ...(ls.needsPcre ? ["-P"] : []), "--max-filesize", "2M", ...globArgs(glob), "-e", rgPattern, rootAbs], rootAbs, true);
    if (o !== null) { files = parse(o); finder = ls.needsPcre ? "pcre2" : "rg"; }
  }
  if (files === null) files = parse(runRg(["--files", "--null", "--max-filesize", "2M", ...globArgs(glob), rootAbs], rootAbs));
  files = files.filter((f) => !credFast(f));
  // phase 1: compute every new content in memory
  const found = []; const skipped = []; let matches = 0, changed = 0;
  for (const f of files) {
    let buf; try { buf = fs.readFileSync(f); } catch (e) { if (finder === "scan") continue; throw e; }
    if (finder === "scan" && buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString("utf8");
    let n = 0; text.replace(re, (m) => { n++; return m; });
    if (!n) continue;
    if (!Buffer.from(text, "utf8").equals(buf)) { skipped.push(rel(f)); continue; }
    matches += n;
    if (matches > maxRep) throw E("OUTPUT_LIMIT", "more than maxReplacements (" + maxRep + ") matches; nothing was written", "Narrow the pattern/path/glob or raise maxReplacements.");
    const nt = text.replace(re, replacement), diff = nt !== text;
    if (diff) changed++;
    found.push({ f, n, mtime: fs.statSync(f).mtimeMs, nt: diff ? nt : null, buf: diff ? buf : null });
  }
  const items = found.map((x) => ({ file: rel(x.f), count: x.n }));
  // phase 2: STALE-check every file to be written, then write; on any failure restore the already written files
  if (!dryRun) {
    const todo = found.filter((x) => x.nt !== null);
    for (const x of todo) {
      let m; try { m = fs.statSync(x.f).mtimeMs; } catch { m = -1; }
      if (m !== x.mtime) throw E("STALE", "file changed during replace: " + rel(x.f) + " (nothing was written)", "Re-run tools.replace.", { rolledBack: false, written: [] });
    }
    const written = []; let cur = null;
    try {
      for (const x of todo) { cur = x; atomicWrite(x.f, x.nt); written.push(x); }
    } catch (e) {
      const pe = sysErr(e), restored = [], restoreFailed = [];
      for (const w of written.slice().reverse()) { try { atomicWrite(w.f, w.buf); restored.push(rel(w.f)); } catch { restoreFailed.push(rel(w.f)); } }
      const rolledBack = restoreFailed.length === 0;
      throw E(rolledBack ? (pe.code || "RESULT_UNKNOWN") : "RESULT_UNKNOWN",
        "write failed at " + rel(cur.f) + " (" + String(pe.message).replace(/^\[\w+\]\s*/, "") + "); " + (rolledBack ? "rolledBack=true, restored " + restored.length + " file(s)" : "rolledBack=false, could not restore: " + restoreFailed.join(", ")),
        rolledBack ? "No files were changed; fix the cause (locked/read-only file?) and re-run." : "Inspect the files listed in restoreFailed; they hold the new content.",
        { rolledBack, restored, restoreFailed, failedFile: rel(cur.f) });
    }
    for (const x of todo) { try { readState[x.f] = fs.statSync(x.f).mtimeMs; } catch {} }
  }
  const res = { files: found.length, matches, changed, items, dryRun: !!dryRun, finder };
  if (skipped.length) res.skipped = skipped;
  return res;
});

// ---------- ref store ----------
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const checkId = (id) => { if (typeof id !== "string" || !ID_RE.test(id)) throw E("INVALID_ARGUMENT", "invalid ref id", "Pass the id returned by ref.put / detailsRef."); return id; };
const refFile = (id) => path.join(dir, id + ".json");
const jobFile = (id) => path.join(jobsDir, id + ".json");
const newId = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
const ENVELOPE = 96;
const pageRows = (rows, offset, limit, maxBytes, extra) => {
  const total = rows.length, items = [];
  let used = ENVELOPE;
  const end = Math.min(total, offset + limit);
  for (let i = offset; i < end; i++) {
    const b = Buffer.byteLength(JSON.stringify(rows[i] === undefined ? null : rows[i])) + 1;
    if (used + b > maxBytes) {
      if (!items.length) throw E("OUTPUT_LIMIT", "row " + i + " needs " + b + " bytes, over maxBytes " + maxBytes, "Raise maxBytes or select fewer fields: ref.page(id,{offset:" + i + ",limit:1,fields:[...]}).", { row: i, bytes: b });
      break;
    }
    items.push(rows[i]); used += b;
  }
  const next = offset + items.length;
  const nextOffset = next < total ? next : null;
  return Object.assign({ total, offset, items, nextOffset, complete: nextOffset === null, omitted: Math.max(0, end - offset - items.length) }, extra || {});
};
const ref = {
  put: guard((value) => {
    const s = JSON.stringify(value);
    if (s === undefined) throw E("INVALID_ARGUMENT", "value is not JSON-serializable", "Pass JSON data.");
    const id = newId("r");
    const f = refFile(id), t = tmpName(f);
    fs.writeFileSync(t, s); renameRetry(t, f);
    return id;
  }),
  page: guard((id, o = {}) => {
    checkId(id); A(o, "ref.page");
    const { fields, equals } = o;
    const offset = optInt(o.offset, "offset", 0, 0, 1e12), limit = optInt(o.limit, "limit", 50, 1, 1e6), maxBytes = optInt(o.maxBytes, "maxBytes", 16384, 128, 64 << 20);
    let isJob = false, f = refFile(id);
    if (!fs.existsSync(f)) { f = jobFile(id); isJob = true; }
    let raw;
    try { raw = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") throw E("NOT_FOUND", "ref not found or expired: " + id, "Refs live 24h per session; re-create the data."); throw e; }
    let v = JSON.parse(raw);
    if (typeof v === "string") {
      let n = Math.min(limit * 100, v.length - offset);
      if (n < 0) n = 0;
      let text = v.slice(offset, offset + n);
      while (text.length > 1 && Buffer.byteLength(JSON.stringify(text)) + ENVELOPE > maxBytes) text = text.slice(0, Math.floor(text.length / 2));
      const next = offset + text.length;
      return { total: v.length, offset, text, nextOffset: next < v.length ? next : null, complete: next >= v.length, omitted: 0 };
    }
    let extra;
    if (isJob || (v && !Array.isArray(v) && Array.isArray(v.items) && v.kind === "job")) { extra = { job: { id: v.id, status: v.status, root: v.root } }; v = v.items; }
    if (!Array.isArray(v)) return v;
    if (equals) v = v.filter((r) => Object.keys(equals).every((k) => r && r[k] === equals[k]));
    if (fields) v = v.map((r) => r && typeof r === "object" ? Object.fromEntries(fields.map((k) => [k, r[k]])) : r);
    return pageRows(v, offset, limit, maxBytes, extra);
  }),
  release: guard((id) => {
    checkId(id);
    if (!fs.existsSync(refFile(id)) && fs.existsSync(jobFile(id))) throw E("POLICY_DENIED", "job logs are read-only", "Job logs are kept for recovery; just stop using the id.");
    try { fs.unlinkSync(refFile(id)); return true; } catch { return false; }
  }),
};
ref.del = ref.release;

// ---------- batch (copy / move / remove) ----------
const MAX_OPS = 512;
const WINDEV = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;
const normRel = (p, what) => {
  if (typeof p !== "string" || p === "") throw E("INVALID_ARGUMENT", what + " must be a non-empty string", "Use a root-relative forward-slash path.");
  if (/[\u0000-\u001f]/.test(p)) throw E("INVALID_ARGUMENT", what + " contains control characters", "Remove control characters.");
  if (p.includes("\\")) throw E("INVALID_ARGUMENT", what + " contains a backslash", "Use forward slashes.");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw E("POLICY_DENIED", what + " must be relative to root, not absolute: " + p, "Use a root-relative path.");
  if (p.includes(":")) throw E("INVALID_ARGUMENT", what + " contains ':' (device/stream names are rejected): " + p, "Remove the ':' part.");
  if (/[<>"|?*]/.test(p)) throw E("INVALID_ARGUMENT", what + " contains a reserved character", "Remove < > \" | ? *.");
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "") throw E("INVALID_ARGUMENT", what + " has an empty segment or trailing slash: " + p, "Use a/b/c without trailing or doubled slashes.");
    if (s === ".") throw E("INVALID_ARGUMENT", what + " contains '.': " + p, "Remove '.' segments.");
    if (s === "..") throw E("POLICY_DENIED", what + " escapes the root with '..': " + p, "Stay inside root.");
    if (/[. ]$/.test(s)) throw E("INVALID_ARGUMENT", what + " segment ends with '.' or space: " + p, "Rename the segment.");
    if (WINDEV.test(s)) throw E("INVALID_ARGUMENT", what + " contains a Windows device name: " + p, "Avoid CON/PRN/AUX/NUL/COMn/LPTn.");
  }
  return segs;
};
const keyOf = (segs) => { const k = segs.join("/"); return WIN || process.platform === "darwin" ? k.toLowerCase() : k; };
const under = (a, b) => a === b || a.startsWith(b + "/");
const overlap = (a, b) => under(a, b) || under(b, a);
const akey = (root, segs) => keyOf([root.split(path.sep).join("/").replace(/[\/]+$/, ""), ...segs]); // absolute comparison key (works across roots)
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; } };
const sha256File = (p) => {
  const h = crypto.createHash("sha256"), fd = fs.openSync(p, "r"), buf = Buffer.allocUnsafe(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
};
// snapshot: metadata digest (content=false) or sha256 content/tree digest (content=true); rejects links and special files
const snapshot = (p, content) => {
  if (credFast(p)) throw E("POLICY_DENIED", "credential path refused: " + rel(p), "Credential files are not copied or moved through these tools.");
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw E("POLICY_DENIED", "contains a symbolic link or junction: " + rel(p), "Links are not copied or moved; remove them from the tree or operate on real files.");
  if (st.isFile()) return content ? "f:" + sha256File(p) : "f:" + st.size + ":" + Math.floor(st.mtimeMs);
  if (st.isDirectory()) {
    const h = crypto.createHash("sha256");
    for (const n of fs.readdirSync(p).sort()) h.update(n + "\0" + snapshot(path.join(p, n), content) + NL);
    return "d:" + h.digest("hex");
  }
  throw E("POLICY_DENIED", "special file (not a regular file or directory): " + rel(p), "Only regular files and directories are supported.");
};
const copyTree = (src, dst) => {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw E("POLICY_DENIED", "unsupported entry: " + rel(src), "Only regular files and directories are supported.");
  if (st.isDirectory()) { fs.mkdirSync(dst); for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dst, n)); }
  else copyFileSynced(src, dst, st);
};
// copy one file: exclusive create, data flushed to disk (fsync) before returning; mode and times are carried over
const copyFileSynced = (src, dst, st) => {
  const buf = Buffer.allocUnsafe(1 << 20);
  const i = fs.openSync(src, "r");
  let o;
  try {
    o = fs.openSync(dst, "wx");
    let n; while ((n = fs.readSync(i, buf, 0, buf.length, null)) > 0) { let w = 0; while (w < n) w += fs.writeSync(o, buf, w, n - w); }
    fs.fsyncSync(o);
  } finally { if (o !== undefined) fs.closeSync(o); fs.closeSync(i); }
  try { fs.chmodSync(dst, st.mode & 0o777); } catch {}
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch {}
};
// Windows read-only files are never deleted implicitly (libuv would silently clear the attribute and delete them)
const unlinkFile = (p, st, force) => { // force: our own staging files only
  if (force && st && (st.mode & 0o200) === 0) { try { fs.chmodSync(p, 0o666); } catch {} }
  else if (WIN && st && (st.mode & 0o200) === 0) throw E("POLICY_DENIED", "file has the read-only attribute: " + rel(p), "Clear it first (attrib -R) if deletion is intended.");
  withRetry(() => fs.unlinkSync(p));
};
const removeTree = (p, prog, force) => { // prog.n counts removed entries, so callers can tell "failed, nothing removed" from "partially removed"
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) { try { withRetry(() => fs.unlinkSync(p)); } catch (e) { try { fs.rmdirSync(p); } catch { throw e; } } if (prog) prog.n++; return; }
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) removeTree(path.join(p, n), prog, force); withRetry(() => fs.rmdirSync(p)); }
  else unlinkFile(p, st, force);
  if (prog) prog.n++;
};
const tagged = (e, effect) => { const x = sysErr(e); try { x.effect = effect; } catch {} return x; };

const resolveRoot = (root) => {
  credGuard(root || ".");
  const r = path.resolve(cwd, root || ".");
  let st; try { st = fs.statSync(r); } catch { throw E("NOT_FOUND", "root not found: " + r, "Check root."); }
  if (!st.isDirectory()) throw E("INVALID_ARGUMENT", "root is not a directory", "Check root.");
  return fs.realpathSync(r);
};
const checkParents = (root, segs, what) => {
  for (let i = 1; i < segs.length; i++) {
    const p = path.join(root, ...segs.slice(0, i)), st = lst(p);
    if (!st) throw E("NOT_FOUND", what + " parent directory does not exist: " + segs.slice(0, i).join("/"), what === "destination" ? "Destination parents must already exist; create them first (tools.bash mkdir)." : "Check the source path.");
    if (st.isSymbolicLink()) throw E("POLICY_DENIED", what + " path passes through a symbolic link or junction: " + segs.slice(0, i).join("/"), "Linked ancestors are never traversed.");
    if (!st.isDirectory()) throw E("INVALID_ARGUMENT", what + " ancestor is not a directory: " + segs.slice(0, i).join("/"), "Fix the path.");
  }
};
// validates one operation against the filesystem; returns {sk, dk, observed}
const preflightOne = (it, roots, protect) => { // roots = {s: source root, d: destination root}; protect = absolute keys
  if (it === null || typeof it !== "object") throw E("INVALID_ARGUMENT", "operation must be an object", "Use {op,path,to?}.");
  const op = it.op;
  if (!["copy", "move", "remove"].includes(op)) throw E("INVALID_ARGUMENT", "op must be copy|move|remove", "Fix op.");
  const s = normRel(it.path, "path");
  let d = null;
  if (op === "remove") { if (it.to !== undefined && it.to !== null) throw E("INVALID_ARGUMENT", "remove does not take 'to'", "Drop 'to'."); }
  else { if (it.to === undefined || it.to === null) throw E("INVALID_ARGUMENT", op + " requires 'to'", "Add 'to'."); d = normRel(it.to, "to"); }
  const sk = akey(roots.s, s), dk = d ? akey(roots.d, d) : null;
  for (const pk of protect) if (overlap(sk, pk) || (dk && overlap(dk, pk))) throw E("POLICY_DENIED", "touches protected path '" + pk + "'", "Remove the operation or change protect.");
  checkParents(roots.s, s, "source");
  credGuard(path.join(roots.s, ...s));
  if (d) credGuard(path.join(roots.d, ...d));
  const sp = path.join(roots.s, ...s), sst = lst(sp);
  if (!sst) throw E("NOT_FOUND", "source does not exist: " + it.path, "Check the path.");
  let observed;
  if (sst.isSymbolicLink()) {
    if (op !== "remove") throw E("POLICY_DENIED", "source is a symbolic link or junction: " + it.path, "Links are not copied or moved; remove can unlink the link itself.");
    observed = "link";
  } else observed = op === "remove" ? (sst.isDirectory() ? "d" : "f") : snapshot(sp, false);
  if (d) {
    checkParents(roots.d, d, "destination");
    if (dk !== sk && under(dk, sk)) throw E("INVALID_ARGUMENT", "destination is inside the source (cyclic): " + it.to, "Choose a destination outside the source.");
    if (lst(path.join(roots.d, ...d))) throw E("EXISTS", "destination already exists: " + it.to, "Batch never overwrites; pick another destination or remove it first.");
  }
  return { sk, dk, op, observed };
};
const crossCheck = (list) => { // list: [{i, op, sk, dk}] ; returns Map index -> message
  const bad = new Map();
  for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const a = list[x], b = list[y];
    let why = null;
    if (a.dk && b.dk && overlap(a.dk, b.dk)) why = "destination overlaps destination of operation " + a.i;
    else if (a.dk && overlap(a.dk, b.sk)) why = "source overlaps destination of operation " + a.i;
    else if (b.dk && overlap(b.dk, a.sk)) why = "destination overlaps source of operation " + a.i;
    else if (overlap(a.sk, b.sk) && (a.op !== "copy" || b.op !== "copy")) why = "source overlaps source of operation " + a.i;
    if (why && !bad.has(b.i)) bad.set(b.i, why);
  }
  return bad;
};

const saveJob = (job) => {
  job.updatedAt = new Date().toISOString();
  const c = { done: 0, failed: 0, unknown: 0, pending: 0 };
  for (const it of job.items) c[it.state === "completed" ? "done" : it.state]++;
  job.status = c.done === job.items.length ? "completed" : c.done === 0 && !c.failed && !c.unknown ? "planned" : c.done > 0 ? "partial" : "failed";
  atomicWrite(jobFile(job.id), JSON.stringify(job));
};
const loadJob = (id) => {
  checkId(id);
  let raw; try { raw = fs.readFileSync(jobFile(id), "utf8"); } catch (e) { if (e.code === "ENOENT") throw E("NOT_FOUND", "job not found: " + id, "Use tools.batch({action:'list'}) to see jobs in this session."); throw e; }
  return JSON.parse(raw);
};
const summary = (job) => {
  const c = { done: 0, failed: 0, unknown: 0, pending: 0 };
  for (const it of job.items) c[it.state === "completed" ? "done" : it.state]++;
  const r = { id: job.id, status: job.status, done: c.done, failed: c.failed, unknown: c.unknown, pending: c.pending, total: job.items.length, detailsRef: job.id };
  const bad = job.items.filter((it) => it.state === "failed" || it.state === "unknown").slice(0, 5);
  if (bad.length) r.errors = bad.map((it) => ({ index: it.index, op: it.op, path: it.path, state: it.state, error: it.error }));
  return r;
};
const lockFile = (id) => path.join(jobsDir, id + ".lock");
const acquire = (id) => {
  const f = lockFile(id);
  for (let k = 0; k < 2; k++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: "wx" }); return; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = 0; try { pid = Number(fs.readFileSync(f, "utf8")); } catch {}
      let alive = false; if (pid && pid !== process.pid) { try { process.kill(pid, 0); alive = true; } catch (er) { alive = er.code === "EPERM"; } }
      if (alive) throw E("POLICY_DENIED", "job " + id + " is being executed by another process (pid " + pid + ")", "Wait for it to finish, then resume.");
      try { fs.unlinkSync(f); } catch {}
    }
  }
  throw E("POLICY_DENIED", "cannot lock job " + id, "Retry.");
};
const release = (id) => { try { fs.unlinkSync(lockFile(id)); } catch {} };

const segsOf = (it) => [normRel(it.path, "path"), it.to ? normRel(it.to, "to") : null];
const postcondition = (roots, it) => {
  try {
    const [s, d] = segsOf(it), sp = path.join(roots.s, ...s), dp = d && path.join(roots.d, ...d);
    if (it.op === "remove") return !lst(sp);
    if (it.op === "copy") return !!lst(sp) && !!lst(dp) && snapshot(sp, true) === snapshot(dp, true);
    const dst = lst(dp);
    if (lst(sp) || !dst) return false;
    return it.observed ? (it.observed[0] === (dst.isDirectory() ? "d" : "f")) : true;
  } catch { return false; }
};
const tmpRelOf = (job, it) => { const segs = normRel(it.to, "to"); return segs.slice(0, -1).concat(".ptc-tmp-" + job.id + "-" + it.index).join("/"); };
const tmpPathOf = (roots, it) => path.join(roots.d, ...normRel(it.tmp, "tmp"));
// Copies and cross-device moves never write the final name directly: data goes to a journaled staging name next to the
// destination (fsync + sha256/tree verification), then a same-volume rename publishes it, then the source is removed.
const execItem = (roots, it, job) => {
  const [s, d] = segsOf(it), sp = path.join(roots.s, ...s), dp = d && path.join(roots.d, ...d);
  if (it.op === "remove") { const prog = { n: 0 }; try { removeTree(sp, prog); } catch (e) { const pe = sysErr(e); if (prog.n) pe.message += " (partially removed: " + prog.n + " entries already deleted; remove is idempotent, resume continues it)"; throw tagged(pe, "none"); } if (lst(sp)) throw tagged(E("RESULT_UNKNOWN", "source still present after remove", "Inspect the path."), "maybe"); return; }
  if (lst(dp)) throw tagged(E("EXISTS", "destination already exists: " + it.to, "Pick another destination."), "none");
  const tp = tmpPathOf(roots, it);
  const dropTmp = () => { try { if (lst(tp)) removeTree(tp, undefined, true); } catch {} return !lst(tp); };
  const stagedCopy = () => {
    if (!dropTmp()) throw tagged(E("RESULT_UNKNOWN", "cannot clear leftover staging path " + it.tmp, "Remove it manually, then resume."), "none");
    it.stage = "copying"; if (job) saveJob(job);
    try { copyTree(sp, tp); } catch (e) { throw tagged(e, dropTmp() ? "none" : "maybe"); }
    let ok = false; try { ok = snapshot(sp, true) === snapshot(tp, true); } catch {}
    if (!ok) throw tagged(E("STALE", "copy verification failed (source changed or copy differs)", "Retry with a new batch."), dropTmp() ? "none" : "maybe");
    if (lst(dp)) { dropTmp(); throw tagged(E("EXISTS", "destination appeared during copy: " + it.to, "Pick another destination."), "none"); }
    try { withRetry(() => fs.renameSync(tp, dp)); } catch (e) { throw tagged(e, dropTmp() ? "none" : "maybe"); }
    it.stage = "placed"; if (job) saveJob(job);
  };
  if (it.op === "copy") return stagedCopy();
  try { withRetry(() => fs.renameSync(sp, dp)); } catch (e) {
    if (e.code !== "EXDEV") throw tagged(e, "none");
    stagedCopy();
    try { removeTree(sp, undefined, true); } catch (er) { throw tagged(er, "maybe"); }
    return;
  }
  if (lst(sp) || !lst(dp)) throw tagged(E("RESULT_UNKNOWN", "move postcondition not met", "Inspect source and destination."), "maybe");
};
// resume of an "unknown" item: verify post-conditions; only a journaled staging copy that never reached its final name is redone
const resumeUnknown = (roots, it) => {
  const dropTmp = () => { try { const tp = tmpPathOf(roots, it); if (lst(tp)) removeTree(tp, undefined, true); } catch {} };
  const fail = (m) => { it.code = "RESULT_UNKNOWN"; it.error = "[RESULT_UNKNOWN] " + m; return "unknown"; };
  if (postcondition(roots, it)) { if (it.tmp) dropTmp(); return "completed"; }
  if (it.op !== "remove" && it.tmp) {
    const [s, d] = segsOf(it), sp = path.join(roots.s, ...s), dp = path.join(roots.d, ...d), tp = tmpPathOf(roots, it);
    const hasSp = !!lst(sp), hasDp = !!lst(dp), hasTp = !!lst(tp);
    if (it.op === "move" && hasSp && hasDp && !hasTp) { // copy was published, source not yet removed: finish without copying again
      let same = false; try { same = snapshot(sp, true) === snapshot(dp, true); } catch {}
      if (!same) return fail("destination and source differ after an interrupted move; not retried. Inspect both paths.");
      try { removeTree(sp, undefined, true); } catch (e) { return fail("verified copy exists at the destination but the source could not be removed: " + String(sysErr(e).message)); }
      return lst(sp) ? fail("source still present after remove") : "completed";
    }
    if (hasSp && !hasDp && (hasTp || it.stage === "copying")) { // interrupted before publishing: nothing visible happened, redo it
      try { if (hasTp) removeTree(tp, undefined, true); } catch (e) { return fail("cannot clear leftover staging path " + it.tmp + ": " + String(sysErr(e).message)); }
      return lst(tp) ? fail("cannot clear leftover staging path " + it.tmp) : "pending";
    }
  }
  return fail("postcondition not met; not retried. Inspect the paths and plan a new batch if needed.");
};
const runItems = (job, roots, idxs) => {
  for (const i of idxs) {
    const it = job.items[i];
    it.state = "unknown"; delete it.error; delete it.code; delete it.stage; it.startedAt = new Date().toISOString();
    if (it.op !== "remove") it.tmp = tmpRelOf(job, it); // journaled before anything is written
    saveJob(job);
    try { execItem(roots, it, job); it.state = "completed"; delete it.startedAt; delete it.stage; delete it.tmp; saveJob(job); }
    catch (e) {
      const pe = sysErr(e);
      it.state = pe.effect === "none" ? "failed" : "unknown";
      it.code = pe.effect === "none" ? (pe.code || "RESULT_UNKNOWN") : "RESULT_UNKNOWN";
      it.error = pe.effect === "none" ? String(pe.message) : "[RESULT_UNKNOWN] " + String(pe.message) + " (partial effects possible; inspect before retrying)";
      if (pe.effect === "none") delete it.stage;
      saveJob(job);
      return;
    }
  }
};
const preflightJob = (job, roots, idxs) => { // returns true if all ok; marks failed items
  const protect = []; // protect paths are root-relative; applied under both roots
  for (const p of job.protect) for (const r of new Set([roots.s, roots.d])) protect.push(akey(r, normRel(p, "protect")));
  const ok = []; let all = true;
  for (const i of idxs) {
    const it = job.items[i];
    try {
      const r = preflightOne(it, roots, protect);
      if (it.observed && it.observed !== r.observed && it.op !== "remove") throw E("STALE", "source changed since it was planned: " + it.path, "Create a new plan.");
      it.observed = r.observed; ok.push({ i, op: r.op, sk: r.sk, dk: r.dk });
      if (it.state === "failed") { it.state = "pending"; delete it.error; delete it.code; }
    } catch (e) { const pe = sysErr(e); all = false; it.state = "failed"; it.code = pe.code || "INVALID_ARGUMENT"; it.error = String(pe.message); }
  }
  for (const [i, why] of crossCheck(ok)) { all = false; const it = job.items[i]; it.state = "failed"; it.code = "INVALID_ARGUMENT"; it.error = "[INVALID_ARGUMENT] " + why; }
  return all;
};

tools.batch = guard((a) => {
  A(a, "batch");
  const { action, operations, protect = [], root, toRoot, id } = a;
  if (action === "list") {
    const rows = fs.readdirSync(jobsDir).filter((n) => n.endsWith(".json")).map((n) => { const p = path.join(jobsDir, n); try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return { id: j.id, status: j.status, total: j.items.length, updatedAt: j.updatedAt }; } catch { return null; } }).filter(Boolean).sort((x, y) => cmp(y.updatedAt, x.updatedAt));
    const offset = optInt(a.offset, "offset", 0, 0, 1e9), limit = optInt(a.limit, "limit", 20, 1, 1000);
    const pg = paginate(rows, offset, limit);
    return { items: pg.items, total: pg.total, complete: pg.complete, nextOffset: pg.nextOffset, jobs: pg.items };
  }
  if (!["plan", "run", "resume"].includes(action)) throw E("INVALID_ARGUMENT", "action must be plan|run|resume", "Fix action.");
  if (action === "resume") {
    if (operations !== undefined || a.protect !== undefined || root !== undefined || toRoot !== undefined) throw E("INVALID_ARGUMENT", "resume accepts only id", "Use tools.batch({action:'resume', id}); root/toRoot/protect/operations come from the stored plan.");
    reqStr(id, "id");
    const job = loadJob(id);
    acquire(id);
    try {
      const roots = { s: resolveRoot(job.root), d: job.toRoot ? resolveRoot(job.toRoot) : null }; roots.d = roots.d || roots.s;
      for (const it of job.items) if (it.state === "unknown") {
        const r = resumeUnknown(roots, it);
        if (r === "completed") { it.state = "completed"; delete it.error; delete it.code; delete it.startedAt; delete it.stage; delete it.tmp; }
        else if (r === "pending") { it.state = "pending"; delete it.error; delete it.code; delete it.startedAt; delete it.stage; }
      }
      const todo = job.items.map((it, i) => i).filter((i) => job.items[i].state === "pending" || job.items[i].state === "failed");
      if (todo.length && preflightJob(job, roots, todo)) runItems(job, roots, todo);
      saveJob(job);
    } finally { release(id); }
    return summary(job);
  }
  if (id !== undefined) throw E("INVALID_ARGUMENT", action + " does not take id", action === "run" ? "run needs operations; use resume with an id to execute a plan." : "plan needs operations.");
  if (!Array.isArray(operations) || !operations.length) throw E("INVALID_ARGUMENT", "operations must be a non-empty array", "Pass operations:[{op,path,to?}].");
  if (operations.length > MAX_OPS) throw E("INVALID_ARGUMENT", "at most " + MAX_OPS + " operations per batch (got " + operations.length + ")", "Split into several batches.");
  if (!Array.isArray(protect) || protect.some((p) => typeof p !== "string")) throw E("INVALID_ARGUMENT", "protect must be a string array", "Pass root-relative paths.");
  if (toRoot !== undefined && toRoot !== null && (typeof toRoot !== "string" || toRoot === "")) throw E("INVALID_ARGUMENT", "toRoot must be a non-empty string", "Pass a directory path (absolute or relative to cwd).");
  const rootAbs = resolveRoot(root);
  const hasTo = typeof toRoot === "string";
  const roots = { s: rootAbs, d: hasTo ? resolveRoot(toRoot) : rootAbs };
  protect.forEach((p) => normRel(p, "protect"));
  const job = { version: 1, kind: "job", id: newId("j"), scope, root: rootAbs, toRoot: hasTo ? roots.d : undefined, protect: protect.slice(), createdAt: new Date().toISOString(), items: operations.map((o, i) => ({ index: i, op: o && o.op, path: o && o.path, to: o && o.to != null ? o.to : undefined, state: "pending" })) };
  const all = job.items.map((x, i) => i);
  const okAll = preflightJob(job, roots, all);
  saveJob(job);
  if (okAll && action === "run") { acquire(job.id); try { runItems(job, roots, all); } finally { release(job.id); } }
  return summary(job);
});

// ---------- run user code ----------
for (const k of Object.keys(tools)) tools[k] = guard(tools[k]);
const AF = Object.getPrototypeOf(async function () {}).constructor;
(async () => {
  let out, err;
  try { out = await new AF("tools", "ref", "console", input.code)(tools, ref, cons); } catch (e) { err = e; }
  let text = lines.join(NL);
  if (out !== undefined) text += (text ? NL : "") + fmt(out);
  if (err) {
    let m;
    if (err && err.name === "PtcError") m = "Error: " + err.message + (err.nextAction ? NL + "nextAction: " + err.nextAction : "");
    else {
      m = "Error: " + (err && err.stack ? String(err.stack).split(NL).slice(0, 4).join(NL) : String(err));
      if (err && typeof err.code === "string") m += NL + "[code: " + err.code + "]";
    }
    text += (text ? NL : "") + m;
  }
  if (text.length > MAX) {
    const id = ref.put(text);
    text = text.slice(0, MAX) + "\n...[truncated " + (text.length - MAX) + " chars; full text saved as ref " + id + "; read in another run_code via ref.page(\"" + id + "\")]";
  }
  process.stdout.write(text || "(run_code completed with no output)", () => process.exit(err ? 2 : 0));
})();
