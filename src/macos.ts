// Detect pbcopy availability ONCE at module load. On Linux containers (NAS
// deployment) pbcopy isn't on PATH; clipboard delivery happens via the per-user
// Mac daemon over /events SSE. Skipping the call cleanly avoids ENOENT spam in
// server logs on every online upload.
let pbcopyAvailable: boolean | null = null
async function isPbcopyAvailable(): Promise<boolean> {
  if (pbcopyAvailable !== null) return pbcopyAvailable
  try {
    const proc = Bun.spawn(['which', 'pbcopy'], { stdout: 'pipe', stderr: 'ignore' })
    const code = await proc.exited
    pbcopyAvailable = code === 0
  } catch {
    pbcopyAvailable = false
  }
  if (!pbcopyAvailable) {
    console.log('[clipboard] pbcopy not on PATH — server-side clipboard delivery disabled (per-user Mac daemons handle it via /events instead)')
  }
  return pbcopyAvailable
}

export async function copyToClipboard(text: string): Promise<void> {
  if (!(await isPbcopyAvailable())) return
  const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
  proc.stdin.write(text)
  await proc.stdin.end()
  const code = await proc.exited
  if (code !== 0) throw new Error(`pbcopy exited with code ${code}`)
}
