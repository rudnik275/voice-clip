function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export const config = {
  openaiApiKey: requireEnv('OPENAI_API_KEY'),
  port: Number(process.env.PORT ?? 8443),
  certPath: process.env.TLS_CERT_PATH ?? './certs/cert.pem',
  keyPath: process.env.TLS_KEY_PATH ?? './certs/key.pem',
  dataDir: process.env.DATA_DIR ?? './data',
}
