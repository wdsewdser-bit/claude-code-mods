// Extra readable directories for ptc-run's read-only sandbox (read + ptc:'only'): job.readPaths becomes
// PTC_RUN_READ_ROOTS (PATH-separated) for the child, plus one appended system-prompt line so the sub-agent knows what
// it may read. Pure and separate from the runner so it can be tested without starting claude; no node imports, because
// the plugin test engine only lets a hooks module import its own files.

/** The directories to hand over: trimmed, non-empty strings, only when the read-only sandbox is actually in use. */
export const readRootsOf = (job, roOnly) => {
  if (!roOnly || !Array.isArray(job?.readPaths)) return []
  const out = []
  for (const p of job.readPaths) {
    if (typeof p !== 'string') continue
    const s = p.trim()
    if (s !== '' && !out.includes(s)) out.push(s)
  }
  return out
}

/** PTC_RUN_READ_ROOTS: joined with the platform's path delimiter (';' on Windows, ':' elsewhere); '' when empty. */
export const readRootsEnv = (roots, delimiter) => (roots.length === 0 ? '' : roots.join(delimiter))

/** The --append-system-prompt pair naming the extra directories; [] when there are none. */
export const readRootsPromptArg = (roots) =>
  roots.length === 0
    ? []
    : ['--append-system-prompt', 'Extra readable directories besides the working directory (read-only mode also reads and searches these): ' + roots.join(', ')]
