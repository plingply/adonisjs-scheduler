import type { ApplicationService } from '@adonisjs/core/types'
import cron from 'node-cron'
import AsyncLock from 'async-lock'
import { FsLoader, type BaseCommand, Kernel } from '@adonisjs/core/ace'

const lock = new AsyncLock()

interface IRunOptions {
  isOneService: boolean
  redisTTL: number
  enabled: boolean
  timeout: number
  key: string
  onBusy?: () => any | PromiseLike<any>
}

const run = async (cb: () => any | PromiseLike<any>, options: IRunOptions, app: any) => {
  if (options.isOneService) {
    const redis = await app.container.make('redis')
    const lockKey = 'scheduler:lock:' + options.key
    const ttl = options.redisTTL // 锁的有效期（秒）
    const acquired = await redis.set(lockKey, '1', 'EX', ttl, 'NX')
    if (!acquired) return
  }

  if (!options.enabled) return await cb()

  if (lock.isBusy(options.key)) {
    if (options.onBusy) {
      await options.onBusy()
    }
    return
  }

  await lock.acquire(options.key, cb, { maxPending: 1, timeout: options.timeout })
}

export class Worker {
  tasks: cron.ScheduledTask[] = []
  loaders: any[] = []
  booted = false

  constructor(public app: ApplicationService) {}

  async boot() {
    if (this.booted) return

    const schedule = await this.app.container.make('scheduler')
    await schedule.boot()

    const fsLoader = new FsLoader<typeof BaseCommand>(this.app.commandsPath())
    this.loaders = [fsLoader]

    this.app.rcFile.commands.forEach((commandModule) => {
      this.loaders.push(() =>
        typeof commandModule === 'function' ? commandModule() : this.app.import(commandModule)
      )
    })

    this.booted = true
  }

  async start() {
    await this.boot()

    const schedule = await this.app.container.make('scheduler')
    const logger = await this.app.container.make('logger')

    if (schedule.onStartingCallback) {
      await schedule.onStartingCallback()
    }

    for (let index = 0; index < schedule.items.length; index++) {
      const command = schedule.items[index]
      this.tasks.push(
        cron.schedule(
          command.expression,
          async () => {
            try {
              switch (command.type) {
                case 'command':
                  const ace = new Kernel(this.app)

                  for (const loader of this.loaders) {
                    ace.addLoader(loader)
                  }

                  for (const callback of command.beforeCallbacks) {
                    await callback()
                  }
                  await run(
                    () => ace.exec(command.commandName, command.commandArgs),
                    {
                      isOneService: command.config.isOneService,
                      redisTTL: command.config.redisTTL,
                      enabled: command.config.withoutOverlapping,
                      timeout: command.config.expiresAt,
                      key: `${index}-${command.commandName}-${command.commandArgs}`,
                      onBusy: () => {
                        logger.warn(
                          `Command ${index}-${command.commandName}-${command.commandArgs} is busy`
                        )
                      },
                    },
                    this.app
                  )
                  for (const callback of command.afterCallbacks) {
                    await callback()
                  }
                  break

                case 'callback':
                  for (const callback of command.beforeCallbacks) {
                    await callback()
                  }
                  await run(
                    () => command.callback(),
                    {
                      isOneService: command.config.isOneService,
                      redisTTL: command.config.redisTTL,
                      enabled: command.config.withoutOverlapping,
                      timeout: command.config.expiresAt,
                      key: `${index}-callback`,
                      onBusy: () => {
                        logger.warn(`Callback ${index} is busy`)
                      },
                    },
                    this.app
                  )
                  for (const callback of command.afterCallbacks) {
                    await callback()
                  }

                default:
                  break
              }
            } catch (error) {
              logger.error(error)
            }
          },
          {
            scheduled: command.config.enabled,
            timezone: command.config.timezone,
            runOnInit: command.config.enabled && command.config.immediate,
          }
        )
      )
    }

    logger.info(`Schedule worker started successfully.`)

    if (schedule.onStartedCallback) {
      await schedule.onStartedCallback()
    }
  }

  async stop() {
    await Promise.all(this.tasks.map((task) => task.stop()))
  }
}
