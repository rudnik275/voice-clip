export async function copyToClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
  proc.stdin.write(text)
  await proc.stdin.end()
  const code = await proc.exited
  if (code !== 0) throw new Error(`pbcopy exited with code ${code}`)
}
