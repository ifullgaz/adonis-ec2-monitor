import { IgnitorFactory } from '@adonisjs/core/factories'
import { setApp } from '@adonisjs/core/services/app'
import { type ApplicationService } from '@adonisjs/core/types'

let application: ApplicationService | undefined

export function getApp() {
  if (!application) {
    throw new Error('Test application is not booted')
  }
  return application
}

/**
 * Configure specs boot short-lived apps, and those replace the global app.
 * Point it back at the shared test app before the next spec uses the logger.
 */
export function restoreTestApp() {
  setApp(getApp())
}

export async function bootTestApp() {
  if (application) {
    return application
  }

  application = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(new URL('../../', import.meta.url), {
      importer: (filePath) => import(filePath),
    })
    .createApp('test')

  await application.init()
  await application.boot()
  await silence(application)
  return application
}

export async function bootApplication(
  options: {
    appRoot?: URL
    rcFileContents?: Record<string, unknown>
    config?: Record<string, unknown>
  } = {}
) {
  const factory = new IgnitorFactory().withCoreProviders().withCoreConfig()
  if (options.rcFileContents) {
    factory.merge({ rcFileContents: options.rcFileContents })
  }
  if (options.config) {
    factory.merge({ config: options.config })
  }

  const app = factory
    .create(options.appRoot ?? new URL('../../', import.meta.url), {
      importer: (filePath) => import(filePath),
    })
    .createApp('web')

  await app.init()
  await app.boot()
  await silence(app)
  return app
}

async function silence(app: ApplicationService) {
  const logger = await app.container.make('logger')
  logger.level = 'silent'
}

export async function shutdownTestApp() {
  if (!application) {
    return
  }
  await application.terminate()
  application = undefined
}
