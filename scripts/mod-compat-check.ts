#!/usr/bin/env node
/**
 * mod-compat-check.ts -- static compatibility report for the local mods.
 *
 * What it does
 *   1. Walks every mod in the repository and extracts
 *        - API calls:   $.namespace.method(...)
 *        - events:      on('event.name', ...) inside a register module
 *   2. Reads the installed claude binary as raw bytes (the same thing as
 *      "grep -a") and looks for each name as a quoted literal, as a bare
 *      substring, and under a "<namespace>.*" wildcard.
 *   3. Cross-checks the names against the *.d.ts declarations shipped with
 *      the mods.
 *
 * It only reports.  It does not modify a mod, run a mod, or call a model.
 *
 * Why the binary
 *   Mods register through a host-provided $ API.  When the host renames an
 *   event or drops an API method there is no compile error: on() simply
 *   never fires and the mod fails silently.  The strings in the binary are
 *   the only local source of truth for what this Claude Code build offers.
 *
 * usage
 *   node scripts/mod-compat-check.ts [options]
 *     --claude PATH   claude binary (default: this machine's npm install)
 *     --mods DIR      mods repository root (default: parent of scripts/)
 *     --contract FILE engine-generated plugin API declarations (default: the
 *                     newest .claude-plugin/types/claude-code/index.d.ts the
 *                     engine laid beside an installed local mod)
 *     --json FILE     write a machine-readable report as well
 *     --strict        also exit 1 when an item is merely suspicious
 *     --quiet         summary only
 *
 * exit codes
 *   0  nothing missing
 *   1  a name is missing (or suspicious with --strict)
 *   2  the check could not run (no binary, no mods, unreadable files)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const DEFAULT_CLAUDE =
  'C:/Users/yadaz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out',
                           '.cache', 'coverage', '.turbo', '.next'])
const API_RE = /\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g
const EVENT_RE = /\bon\(\s*(['"])([^'"]+)\1/g
const EVENT_NAME_RE = /^[A-Za-z][\w.-]*$/

interface Usage {
  mod: string
  kind: 'api' | 'event'
  token: string
  file: string
  line: number
  scope: 'source' | 'test'
}

interface Finding extends Usage {
  status: 'ok' | 'dynamic' | 'substring' | 'missing'
  detail: string
  declared: boolean
}

interface ModInfo {
  name: string
  dir: string
  files: string[]
}

function walk(dir: string, out: string[]): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

function rel(from: string, file: string): string {
  return path.relative(from, file).split(path.sep).join('/')
}

function discoverMods(root: string): ModInfo[] {
  const mods: ModInfo[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return mods
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const dir = path.join(root, entry.name)
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json')
    if (!fs.existsSync(manifest)) continue
    const files = walk(dir, []).filter((file) => SOURCE_EXT.has(path.extname(file)))
    mods.push({ name: entry.name, dir, files })
  }
  mods.sort((a, b) => a.name.localeCompare(b.name))
  return mods
}

function inComment(line: string, index: number): boolean {
  if (line.slice(0, index).includes('//')) return true
  const trimmed = line.trimStart()
  return trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function isRegisterModule(file: string, text: string): boolean {
  if (file.split(path.sep).includes('hooks')) return true
  return text.includes('export const register')
}

function extractUsages(mod: ModInfo, root: string): Usage[] {
  const usages: Usage[] = []
  const seen = new Set<string>()
  for (const file of mod.files) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    const scope: 'source' | 'test' =
      file.split(path.sep).includes('tests') ? 'test' : 'source'
    const registers = isRegisterModule(file, text)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      API_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = API_RE.exec(line)) !== null) {
        if (inComment(line, match.index)) continue
        const token = match[1]
        const key = 'api|' + token + '|' + scope
        if (seen.has(key)) continue
        seen.add(key)
        usages.push({ mod: mod.name, kind: 'api', token, file: rel(root, file),
                      line: i + 1, scope })
      }
      if (!registers) continue
      EVENT_RE.lastIndex = 0
      while ((match = EVENT_RE.exec(line)) !== null) {
        if (inComment(line, match.index)) continue
        const token = match[2]
        if (!EVENT_NAME_RE.test(token)) continue
        const key = 'event|' + token + '|' + scope
        if (seen.has(key)) continue
        seen.add(key)
        usages.push({ mod: mod.name, kind: 'event', token, file: rel(root, file),
                      line: i + 1, scope })
      }
    }
  }
  return usages
}

function declaredNames(mods: ModInfo[]): { names: Set<string>; files: string[] } {
  const names = new Set<string>()
  const files: string[] = []
  for (const mod of mods) {
    for (const file of mod.files) {
      if (!file.endsWith('.d.ts')) continue
      files.push(file)
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const quoted = text.match(/['"]([A-Za-z_$][\w$.]*)['"]/g) || []
      for (const raw of quoted) names.add(raw.slice(1, -1))
      const identifiers = text.match(/\b[A-Za-z_$][\w$]*\b/g) || []
      for (const name of identifiers) names.add(name)
    }
  }
  return { names, files }
}

/** grep -a -F -o over the binary; null when grep is unavailable. */
function grepCounts(binary: string, needles: string[]): Map<string, number> | null {
  const patternFile = path.join(os.tmpdir(),
                                'mod-compat-' + process.pid + '.patterns')
  fs.writeFileSync(patternFile, needles.join('\n') + '\n', 'utf8')
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('grep', ['-a', '-F', '-o', '-f', patternFile, binary], {
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      timeout: 300000,
    })
  } finally {
    try { fs.unlinkSync(patternFile) } catch { /* ignore */ }
  }
  if (result.error) return null
  if (result.status !== 0 && result.status !== 1) return null
  const counts = new Map<string, number>()
  const text = String(result.stdout || '')
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    counts.set(line, (counts.get(line) || 0) + 1)
  }
  return counts
}

/** Portable fallback: one read of the binary, indexOf per needle. */
function bufferCounts(binary: string, needles: string[]): Map<string, number> {
  const data = fs.readFileSync(binary)
  const counts = new Map<string, number>()
  for (const needle of needles) {
    const probe = Buffer.from(needle, 'utf8')
    let index = data.indexOf(probe)
    let hits = 0
    while (index !== -1) {
      hits++
      index = data.indexOf(probe, index + 1)
    }
    if (hits > 0) counts.set(needle, hits)
  }
  return counts
}

function namespaceOf(token: string): string {
  const dot = token.indexOf('.')
  return dot === -1 ? token : token.slice(0, dot)
}

function lastSegment(token: string): string {
  const dot = token.lastIndexOf('.')
  return dot === -1 ? token : token.slice(dot + 1)
}

/** Newest engine-laid contract beside an installed local mod, or ''. */
function defaultContract(): string {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'local-mods')
  let best = ''
  let bestTime = -1
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sub = path.join(dir, entry.name)
      const file = path.join(sub, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
      try {
        const time = fs.statSync(file).mtimeMs
        if (time > bestTime) {
          best = file
          bestTime = time
        }
      } catch {
        walk(sub, depth + 1)
      }
    }
  }
  walk(base, 0)
  return best
}

/** Member names the contract declares (`name:`, `name?:`, `name(`). */
function contractMembers(file: string): Set<string> | null {
  if (!file) return null
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const members = new Set<string>()
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\??\s*[:(]/g)) members.add(m[1])
  return members
}

function classify(usages: Usage[], counts: Map<string, number>,
                  declared: Set<string>, contract: Set<string> | null): Finding[] {
  return usages.map((usage) => {
    const quoted = '"' + usage.token + '"'
    const bare = counts.get(usage.token) || 0
    const exact = counts.get(quoted) || 0
    const namespace = namespaceOf(usage.token)
    const wildcard = '"' + namespace + '.*"'
    const wildcardHits = counts.get(wildcard) || 0
    // Some namespaces are composed at runtime, e.g. `classic.${name}`.
    const dynamicHits = counts.get(namespace + '.${') || 0
    const namespaceMembers = counts.get('"' + namespace + '.') || 0
    const isDeclared = declared.has(usage.token)
    let status: Finding['status'] = 'missing'
    let detail = namespaceMembers > 0
      ? 'no literal "' + usage.token + '"; "' + namespace + '." appears ' +
        namespaceMembers + ' time(s) with other members, so this member may ' +
        'have been renamed or dropped'
      : 'not found in the binary'
    if (exact > 0) {
      status = 'ok'
      detail = 'quoted literal in binary (' + exact + ')'
    } else if (dynamicHits > 0 || wildcardHits > 0) {
      status = 'dynamic'
      detail = 'no literal "' + usage.token + '"; the host composes ' +
        '"' + namespace + '.*" at runtime (' +
        (dynamicHits ? namespace + '.${...} in the binary' : 'namespace wildcard') +
        '), so membership is not statically verifiable'
    } else if (usage.kind === 'api' && contract !== null &&
               usage.token.split('.').every((seg) => contract.has(seg))) {
      // The host builds `$` as plain objects, so a member such as
      // plugin.root never appears as a quoted literal in the binary.
      status = 'ok'
      detail = 'declared in the engine contract'
    } else if (bare > 0) {
      status = 'substring'
      detail = 'only appears as a bare substring (' + bare +
        '), not as a quoted literal'
    } else if (isDeclared) {
      status = 'substring'
      detail = 'not in the binary but declared in a mod .d.ts'
    }
    return { ...usage, status, detail, declared: isDeclared }
  })
}

function claudeVersion(binary: string): string {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  const text = String(result.stdout || '') + ' ' + String(result.stderr || '')
  const match = text.match(/\d+\.\d+\.\d+[-\w.+]*/)
  if (match) return match[0]
  try {
    const pkg = path.join(path.dirname(binary), '..', 'package.json')
    const data = JSON.parse(fs.readFileSync(pkg, 'utf8'))
    if (data && typeof data.version === 'string') return data.version + ' (package.json)'
  } catch { /* ignore */ }
  return 'unknown'
}

function parseArgs(argv: string[]) {
  const options = {
    claude: DEFAULT_CLAUDE,
    contract: '',
    mods: path.resolve(path.dirname(process.argv[1] || '.'), '..'),
    json: '',
    strict: false,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--claude') options.claude = argv[++i]
    else if (arg === '--mods') options.mods = path.resolve(argv[++i])
    else if (arg === '--contract') options.contract = path.resolve(argv[++i])
    else if (arg === '--json') options.json = path.resolve(argv[++i])
    else if (arg === '--strict') options.strict = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/mod-compat-check.ts [--claude PATH] ' +
                  '[--mods DIR] [--contract FILE] [--json FILE] [--strict] [--quiet]')
      process.exit(0)
    } else {
      console.error('unknown argument: ' + arg)
      process.exit(2)
    }
  }
  return options
}

function main(): number {
  const options = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(options.claude)) {
    console.error('claude binary not found: ' + options.claude)
    return 2
  }
  if (!fs.existsSync(options.mods)) {
    console.error('mods root not found: ' + options.mods)
    return 2
  }
  const mods = discoverMods(options.mods)
  if (mods.length === 0) {
    console.error('no mods found under ' + options.mods)
    return 2
  }

  const usages: Usage[] = []
  for (const mod of mods) usages.push(...extractUsages(mod, options.mods))
  const unique = new Map<string, Usage>()
  for (const usage of usages) {
    unique.set(usage.kind + '|' + usage.mod + '|' + usage.token, usage)
  }
  const tokens = [...unique.values()]

  const needles = new Set<string>()
  for (const usage of tokens) {
    needles.add(usage.token)
    needles.add('"' + usage.token + '"')
    needles.add('"' + namespaceOf(usage.token) + '.*"')
    needles.add(namespaceOf(usage.token) + '.${')
    needles.add('"' + namespaceOf(usage.token) + '.')
  }
  let counts = grepCounts(options.claude, [...needles])
  let scanner = 'grep -a -F -o'
  if (counts === null) {
    counts = bufferCounts(options.claude, [...needles])
    scanner = 'built-in buffer scan'
  }

  const { names, files: declFiles } = declaredNames(mods)
  const contractFile = options.contract || defaultContract()
  const contract = contractMembers(contractFile)
  const findings = classify(tokens, counts, names, contract)
  // Test-only usages are reported but never fail the check: mocks are
  // allowed to name APIs the shipped code does not use.
  const shipped = findings.filter((f) => f.scope === 'source')
  const testOnly = findings.filter((f) => f.scope === 'test')
  const missing = shipped.filter((f) => f.status === 'missing')
  const suspicious = shipped.filter((f) => f.status === 'dynamic' ||
                                             f.status === 'substring')
  const apiFindings = findings.filter((f) => f.kind === 'api')
  const eventFindings = findings.filter((f) => f.kind === 'event')

  const sourceFiles = mods.reduce((sum, mod) =>
    sum + mod.files.filter((f) => !f.split(path.sep).includes('tests')).length, 0)
  const shippedApi = apiFindings.filter((f) => f.scope === 'source').length
  const shippedEvents = eventFindings.filter((f) => f.scope === 'source').length
  const version = claudeVersion(options.claude)
  const stamp = new Date().toISOString()

  const lines: string[] = []
  lines.push('mod-compat-check  ' + stamp)
  lines.push('claude binary     ' + options.claude + '  (' + version + ')')
  lines.push('mods root         ' + options.mods)
  lines.push('scanned           ' + mods.length + ' mods, ' + sourceFiles +
             ' source files, ' + shippedApi + ' API calls, ' +
             shippedEvents + ' event names (tests excluded)')
  lines.push('binary scan       ' + scanner)
  lines.push('engine contract   ' + (contract ? contractFile : '(none found)'))
  lines.push('')

  function section(title: string, items: Finding[]) {
    lines.push('== ' + title)
    const byMod = new Map<string, Finding[]>()
    for (const item of items) {
      const list = byMod.get(item.mod) || []
      list.push(item)
      byMod.set(item.mod, list)
    }
    for (const mod of mods) {
      const list = byMod.get(mod.name) || []
      const bad = list.filter((f) => f.status !== 'ok')
      lines.push('  ' + mod.name.padEnd(14) + String(list.length).padStart(3) +
                 ' checked, ' + String(list.length - bad.length).padStart(3) +
                 ' ok' + (bad.length ? ', ' + bad.length + ' to review' : ''))
      if (options.quiet) continue
      for (const item of bad) {
        const scope = item.scope === 'test' ? '  (test only)' : ''
        lines.push('    ' + item.status.toUpperCase().padEnd(10) + ' ' +
                   item.token.padEnd(24) + ' ' + item.file + ':' + item.line +
                   scope)
        lines.push('               ' + item.detail)
      }
    }
    if (items.length === 0) lines.push('  (none)')
    lines.push('')
  }

  section('API calls  ($.namespace.method)', apiFindings)
  section('events     (on(\'name\', ...))', eventFindings)

  lines.push('== type declarations')
  if (declFiles.length === 0) {
    lines.push('  none shipped with the mods; binary strings are the only source')
  } else {
    for (const file of declFiles) {
      lines.push('  ' + rel(options.mods, file))
    }
    const declaredApi = apiFindings.filter(
      (f) => f.declared && f.scope === 'source').length
    lines.push('  ' + declaredApi + ' of ' + shippedApi +
               ' shipped API names appear in the declarations')
    if (declaredApi === 0) {
      lines.push('  the declarations cover plugin state only, not the $ runtime API')
    }
  }
  lines.push('')

  lines.push('summary: ' + shippedApi + ' API names + ' +
             shippedEvents + ' event names shipped; ' +
             missing.length + ' missing, ' + suspicious.length +
             ' suspicious' +
             (testOnly.length ? ', ' + testOnly.length +
              ' test-only usage(s) ignored' : ''))
  for (const item of missing) {
    lines.push('  MISSING   ' + item.token + '  (' + item.mod + ', ' +
               item.file + ':' + item.line + ')')
  }
  lines.push('note: a mod that subscribes to an event this build no longer ' +
             'emits fails silently -- on() never fires. Re-run this check ' +
             'after every Claude Code upgrade.')

  console.log(lines.join('\n'))

  if (options.json) {
    const report = {
      generatedAt: stamp,
      claudeBinary: options.claude,
      claudeVersion: version,
      modsRoot: options.mods,
      scanner,
      summary: {
        mods: mods.length,
        apiNames: apiFindings.length,
        eventNames: eventFindings.length,
        missing: missing.length,
        suspicious: suspicious.length,
        testOnly: testOnly.length,
      },
      findings,
      declarationFiles: declFiles.map((file) => rel(options.mods, file)),
    }
    fs.writeFileSync(options.json, JSON.stringify(report, null, 1) + '\n', 'utf8')
    console.log('json: ' + options.json)
  }

  if (missing.length > 0) return 1
  if (options.strict && suspicious.length > 0) return 1
  return 0
}

process.exit(main())
