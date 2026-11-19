import { test } from '@japa/runner'
import { type ApplicationService } from '@adonisjs/core/types'
import Ec2TargetGroupMonitor from '../src/core/ec2_target_group_monitor.js'
import Ec2TargetGroupMonitorProvider from '../providers/provider.js'
import { bootApplication, restoreTestApp } from './helpers/app.js'
import {
  delay,
  ecsMetadataUrl,
  healthyMetadata,
  healthyTarget,
  hostPort,
  instanceId,
  loggedError,
  logMessages,
  metadataUrl,
  monitorConfig,
  targetGroupArn,
  waitForState,
  waitUntil,
  withDoubles,
} from './helpers/monitor.js'

test.group('Ec2TargetGroupMonitorProvider', (group) => {
  group.each.timeout(15000)

  test('registers one monitor from the ec2_monitor config', async ({ assert }) => {
    const configuredUrl = 'http://metadata.test/latest'
    await withDoubles(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: (call) => healthyMetadata(call, configuredUrl),
        health: healthyTarget,
      },
      async ({ fetchMock, aws }) => {
        const app = await bootApplication({
          config: {
            ec2_monitor: monitorConfig({ metadataUrl: configuredUrl }),
          },
        })
        let monitor: Ec2TargetGroupMonitor | undefined
        try {
          const provider = new Ec2TargetGroupMonitorProvider(app)
          provider.register()
          const first = await app.container.make('ec2TargetGroupMonitor')
          const second = await app.container.make('ec2TargetGroupMonitor')
          monitor = first

          assert.strictEqual(first, second)
          assert.instanceOf(first, Ec2TargetGroupMonitor)

          const pending = waitForState(first)
          await first.start()
          assert.equal(await pending, 'healthy')
          assert.equal(fetchMock.calls[0].url, `${configuredUrl}/api/token`)
          assert.equal(aws.inputs[0]?.Targets?.[0]?.Id, instanceId)
          assert.equal(aws.inputs[0]?.Targets?.[0]?.Port, hostPort)
        } finally {
          monitor?.stop()
          await app.terminate()
          restoreTestApp()
        }
      }
    )
  })

  test('starts during ready and stops when the application terminates', async ({ assert }) => {
    let tokenRequested = false
    let resolveToken = () => {}
    const tokenGate = new Promise<void>((resolve) => {
      resolveToken = resolve
    })

    await withDoubles(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: async (call) => {
          if (call.url === `${metadataUrl}/api/token`) {
            tokenRequested = true
            await tokenGate
          }
          return healthyMetadata(call)
        },
        health: healthyTarget,
      },
      async ({ aws }) => {
        let app: ApplicationService | undefined
        let ready: Promise<void> | undefined
        let monitor: Ec2TargetGroupMonitor | undefined
        try {
          app = await bootApplication({
            config: {
              ec2_monitor: monitorConfig({ pollInterval: 40, pollJitter: 0 }),
            },
          })
          const provider = new Ec2TargetGroupMonitorProvider(app)
          provider.register()
          monitor = await app.container.make('ec2TargetGroupMonitor')
          let settled = false
          ready = provider.ready().then(() => {
            settled = true
          })

          await waitUntil(() => tokenRequested)
          assert.isFalse(settled)
          resolveToken()
          await ready

          const pending = waitForState(monitor)
          assert.equal(await pending, 'healthy')
          const client = monitor.client
          await app.terminate()
          assert.include(aws.destroyed, client)
          await delay(70)
          assert.lengthOf(aws.inputs, 1)
        } finally {
          resolveToken()
          if (ready) {
            await ready.catch(() => {
              return undefined
            })
          }
          monitor?.stop()
          if (app) {
            await app.terminate()
          }
          restoreTestApp()
        }
      }
    )
  })

  test('does not touch the network when the target group arn is unset', async ({ assert }) => {
    await withDoubles({}, async ({ fetchMock, logs }) => {
      const app = await bootApplication()
      try {
        const provider = new Ec2TargetGroupMonitorProvider(app)
        provider.register()
        await provider.ready()
        await delay(40)

        assert.lengthOf(fetchMock.calls, 0)
        assert.lengthOf(logs.errors(), 0)
        assert.lengthOf(logs.debugs(), 0)
      } finally {
        await app.terminate()
        restoreTestApp()
      }
    })
  })

  test('finishes ready when initialization cannot read config', async ({ assert }) => {
    await withDoubles(
      {
        targetGroupArn,
        ecsMetadataUrl,
      },
      async ({ fetchMock, logs, aws }) => {
        const app = await bootApplication()
        try {
          const provider = new Ec2TargetGroupMonitorProvider(app)
          provider.register()
          await provider.ready()
          await delay(40)

          assert.deepEqual(logMessages(logs.errors()), [
            'Failed to get IMDSv2 token',
            'Initialization failed',
            'Failed to start polling',
          ])
          assert.include(loggedError(logs.errors()[0]), 'metadataUrl')
          assert.lengthOf(fetchMock.calls, 0)
          assert.lengthOf(aws.inputs, 0)
        } finally {
          await app.terminate()
          restoreTestApp()
        }
      }
    )
  })

  test('resolves the monitor when the provider is loaded from the rc file', async ({ assert }) => {
    await withDoubles({}, async ({ fetchMock }) => {
      const app = await bootApplication({
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
        config: {
          ec2_monitor: monitorConfig(),
        },
      })
      try {
        const monitor = await app.container.make('ec2TargetGroupMonitor')
        assert.instanceOf(monitor, Ec2TargetGroupMonitor)
        assert.lengthOf(fetchMock.calls, 0)
      } finally {
        await app.terminate()
        restoreTestApp()
      }
    })
  })
})
