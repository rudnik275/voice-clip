import { startServer } from './server'

async function main() {
  const server = await startServer()
  const proto = server.url.protocol.replace(':', '')
  console.log(`Server listening on ${proto}://localhost:${server.port}`)

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, stopping server…`)
    server.stop()
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
