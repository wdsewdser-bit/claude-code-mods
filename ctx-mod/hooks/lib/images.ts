// Where Claude puts the images a person pastes, and which of them a submission
// is carrying. Pure rules only: the engine's file calls stay in register.ts.

/** The extensions a pasted image is written with. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'webp', 'jpg', 'jpeg', 'gif', 'heic'])

/** How recent a pasted image's modification time must be, in ms: wide enough for a long message typed after the paste; the newest N still win. */
export const PASTE_WINDOW_MS = 30 * 60_000

/**
 * The slug Claude gives a working directory under its temp tree: every
 * character that is not a letter or a digit becomes a dash
 * (`D:\Bot\ComfyUI WebUI Test` → `D--Bot-ComfyUI-WebUI-Test`).
 */
export const cwdSlug = (cwd: string): string => cwd.replaceAll(/[^A-Za-z0-9]/g, '-')

/** Whether a file name is one Claude writes a pasted image to. */
export const isImageName = (name: string): boolean => {
  const dot = name.lastIndexOf('.')
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** The number a paste file is named after (`57.png` → 57), or -1 when it has none. */
const sequenceOf = (name: string): number => {
  const digits = /^(\d+)/.exec(name)?.[1]
  return digits === undefined ? -1 : Number(digits)
}

/**
 * The files a paste of `count` images just wrote, in the order they were
 * pasted, or none at all when the directory holds fewer than that many within
 * the window: half a match would point the new window at someone else's
 * picture, which is worse than telling the person to paste again.
 */
export const pickPastedImages = (
  entries: readonly { name: string; kind?: string; mtimeMs: number }[],
  count: number,
  now: number,
  windowMs = PASTE_WINDOW_MS,
): string[] => {
  if (count <= 0) return []
  const recent = entries
    .filter(entry => (entry.kind === undefined || entry.kind === 'file') && isImageName(entry.name))
    // Within the window either way: a clock that ran ahead is no reason to drop one.
    .filter(entry => Math.abs(now - entry.mtimeMs) <= windowMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  if (recent.length < count) return []

  return recent
    .slice(0, count)
    .map(entry => entry.name)
    .sort((left, right) => sequenceOf(left) - sequenceOf(right))
}
