// Production entry: read env via src/config.ts, start the server, wire up
// graceful shutdown on SIGINT/SIGTERM.

import { config } from './config'
import { startServer } from './server'

const server = await startServer({
  dataDir: config.dataDir,
  port: config.port,
  useTls: config.useTls,
  allowlist: config.allowedEmails,
  googleClientId: config.googleClientId,
  googleClientSecret: config.googleClientSecret,
  publicUrl: config.publicUrl,
  adminToken: config.adminToken,
})

console.log(`voice-clip listening on :${server.port}`)

function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`)
  server.stop()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
