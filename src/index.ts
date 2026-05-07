import { createBot } from './bot'

const bot = createBot()

bot.catch((err) => {
  console.error('Bot error:', err)
})

const shutdown = (signal: string) => {
  console.log(`Received ${signal}, stopping bot...`)
  void bot.stop().finally(() => process.exit(0))
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

bot.start({
  onStart: () => console.log('Bot started'),
})
