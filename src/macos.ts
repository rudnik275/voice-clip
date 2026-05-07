export async function copyToClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
  proc.stdin.write(text)
  await proc.stdin.end()
  const code = await proc.exited
  if (code !== 0) throw new Error(`pbcopy exited with code ${code}`)
}

export async function notify(message: string, title: string): Promise<void> {
  const truncated = message.length > 200 ? message.slice(0, 199) + '…' : message
  const proc = Bun.spawn(
    ['terminal-notifier', '-title', title, '-message', truncated, '-sound', 'default'],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  await proc.exited
}
