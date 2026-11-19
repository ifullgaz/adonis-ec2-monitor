import { test } from '@japa/runner'
import { DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import Ec2TargetGroupMonitor from '../src/core/ec2_target_group_monitor.js'
import { type EC2MonitorConfig } from '../src/types/types.js'
import {
  type DoubleOptions,
  type Doubles,
  delay,
  ecsMetadataUrl,
  healthyMetadata,
  healthyTarget,
  hostPort,
  imdsToken,
  instanceId,
  instanceRegion,
  loggedError,
  logMessages,
  metadataUrl,
  monitorConfig,
  resolvedRegion,
  targetGroupArn,
  waitForState,
  waitUntil,
  withDoubles,
} from './helpers/monitor.js'

type MonitorHandlers = DoubleOptions & {
  config?: Partial<EC2MonitorConfig>
}

const metadataFailures = [
  {
    name: 'the token request is rejected',
    url: `${metadataUrl}/api/token`,
    status: 503,
    label: 'Failed to get IMDSv2 token',
    error: 'Token request failed: 503',
    calls: 1,
  },
  {
    name: 'the instance id request is rejected',
    url: `${metadataUrl}/meta-data/instance-id`,
    status: 404,
    label: 'Failed to get instance ID',
    error: 'Instance ID request failed: 404',
    calls: 2,
  },
  {
    name: 'the region request is rejected',
    url: `${metadataUrl}/dynamic/instance-identity/document`,
    status: 500,
    label: 'Failed to get region',
    error: 'Region request failed: 500',
    calls: 3,
  },
  {
    name: 'the ecs metadata request is rejected',
    url: ecsMetadataUrl,
    status: 503,
    label: 'Failed to get host port',
    error: 'ECS metadata request failed: 503',
    calls: 4,
  },
]

const missingPorts = [
  { name: 'ports are missing', body: {} },
  { name: 'the port list is empty', body: { Ports: [] } },
  { name: 'the host port is zero', body: { Ports: [{ HostPort: 0 }] } },
  { name: 'the host port is blank', body: { Ports: [{ HostPort: '' }] } },
  { name: 'the host port is not a number', body: { Ports: [{ HostPort: 'nope' }] } },
]

const uninitialized = [
  {
    name: 'the identity document has no region',
    url: `${metadataUrl}/dynamic/instance-identity/document`,
    response: () => Response.json({}),
    debug: `Initialized: instanceId=${instanceId}, region=undefined, port=${hostPort}`,
  },
  {
    name: 'the instance id is blank',
    url: `${metadataUrl}/meta-data/instance-id`,
    response: () => new Response(''),
    debug: `Initialized: instanceId=, region=${instanceRegion}, port=${hostPort}`,
  },
]

test.group('Ec2TargetGroupMonitor', (group) => {
  group.each.timeout(5000)

  test('does not read metadata when the target group arn is unset', async ({ assert }) => {
    await withMonitor({}, async ({ fetchMock, aws, logs, monitor }) => {
      await monitor.start()
      await delay(60)

      assert.lengthOf(fetchMock.calls, 0)
      assert.lengthOf(aws.inputs, 0)
      assert.lengthOf(logs.errors(), 0)
      assert.lengthOf(logs.debugs(), 0)
    })
  })

  test('reads instance metadata with the imds token and a timeout', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: healthyTarget,
      },
      async ({ fetchMock, logs, monitor }) => {
        let emitted = false
        monitor.on('state', () => {
          emitted = true
        })

        await monitor.start()
        assert.isFalse(emitted)
        assert.deepEqual(
          fetchMock.calls.map((call) => call.url),
          [
            `${metadataUrl}/api/token`,
            `${metadataUrl}/meta-data/instance-id`,
            `${metadataUrl}/dynamic/instance-identity/document`,
            ecsMetadataUrl,
          ]
        )

        const [tokenCall, instanceCall, regionCall, ecsCall] = fetchMock.calls
        assert.equal(tokenCall.method, 'PUT')
        assert.equal(tokenCall.headers.get('x-aws-ec2-metadata-token-ttl-seconds'), '21600')
        assert.isNull(tokenCall.headers.get('x-aws-ec2-metadata-token'))
        assert.instanceOf(tokenCall.signal, AbortSignal)
        assert.equal(tokenCall.signal?.aborted, false)

        assert.equal(instanceCall.method, 'GET')
        assert.equal(instanceCall.headers.get('x-aws-ec2-metadata-token'), imdsToken)
        assert.instanceOf(instanceCall.signal, AbortSignal)
        assert.equal(instanceCall.signal?.aborted, false)
        assert.equal(regionCall.headers.get('x-aws-ec2-metadata-token'), imdsToken)
        assert.instanceOf(regionCall.signal, AbortSignal)
        assert.equal(regionCall.signal?.aborted, false)
        assert.isNull(ecsCall.headers.get('x-aws-ec2-metadata-token'))
        assert.isUndefined(ecsCall.signal)

        assert.deepEqual(logMessages(logs.debugs()), [
          `Initialized: instanceId=${instanceId}, region=${instanceRegion}, port=${hostPort}`,
          'Polling started',
        ])
      }
    )
  })

  test('queries the first host port and emits that target state', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        config: { pollInterval: 50, pollJitter: 0 },
        fetch: healthyMetadata,
        health: () => {
          return {
            TargetHealthDescriptions: [
              { TargetHealth: { State: 'initial' } },
              { TargetHealth: { State: 'healthy' } },
            ],
          }
        },
      },
      async ({ aws, monitor }) => {
        const pending = waitForState(monitor)
        await monitor.start()
        const startedAt = performance.now()
        const state = await pending
        const elapsed = performance.now() - startedAt

        assert.equal(state, 'initial')
        assert.isAtLeast(elapsed, 30)
        assert.instanceOf(aws.commands[0], DescribeTargetHealthCommand)
        assert.deepEqual(aws.inputs[0], {
          TargetGroupArn: targetGroupArn,
          Targets: [{ Id: instanceId, Port: hostPort }],
        })
        assert.equal(await resolvedRegion(monitor.client), instanceRegion)
        assert.strictEqual(monitor.client, monitor.client)
      }
    )
  })

  test('coerces a string host port', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: (call) => {
          if (call.url === ecsMetadataUrl) {
            return Response.json({ Ports: [{ HostPort: '3210' }, { HostPort: 1 }] })
          }
          return healthyMetadata(call)
        },
        health: healthyTarget,
      },
      async ({ aws, monitor }) => {
        const pending = waitForState(monitor)
        await monitor.start()
        await pending
        assert.equal(aws.inputs[0]?.Targets?.[0]?.Port, 3210)
      }
    )
  })

  test('keeps polling and does not replay an earlier state', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: healthyTarget,
      },
      async ({ monitor }) => {
        const first: unknown[] = []
        monitor.on('state', (state) => {
          first.push(state)
        })
        await monitor.start()
        await waitUntil(() => first.length === 1)

        const late: unknown[] = []
        monitor.on('state', (state) => {
          late.push(state)
        })
        await waitUntil(() => late.length === 1)
        monitor.stop()

        assert.deepEqual(first.slice(0, 2), ['healthy', 'healthy'])
        assert.deepEqual(late, ['healthy'])
      }
    )
  })

  test('waits for the poll interval plus the full jitter', async ({ assert }) => {
    const originalRandom = Math.random
    Math.random = () => 1
    try {
      let elapsed = 0
      await withMonitor(
        {
          targetGroupArn,
          ecsMetadataUrl,
          config: { pollInterval: 40, pollJitter: 80 },
          fetch: healthyMetadata,
          health: healthyTarget,
        },
        async ({ monitor }) => {
          await monitor.start()
          Math.random = originalRandom
          const startedAt = performance.now()
          await waitForState(monitor)
          elapsed = performance.now() - startedAt
        }
      )
      assert.isAtLeast(elapsed, 100)
      assert.isAtMost(elapsed, 500)
    } finally {
      Math.random = originalRandom
    }
  })

  test('emits each target health state unchanged', async ({ assert }) => {
    const states = ['initial', 'healthy', 'unhealthy', 'draining', 'unused', 'unavailable']
    let index = 0
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: () => {
          const state = states[index]
          index++
          return {
            TargetHealthDescriptions: [{ TargetHealth: { State: state } }],
          }
        },
      },
      async ({ monitor }) => {
        const emitted: unknown[] = []
        monitor.on('state', (state) => {
          emitted.push(state)
        })
        await monitor.start()
        await waitUntil(() => emitted.length === states.length)
        monitor.stop()
        assert.deepEqual(emitted, states)
      }
    )
  })

  test('emits null when the health response has no state', async ({ assert }) => {
    const responses = [
      { TargetHealthDescriptions: [] },
      {},
      { TargetHealthDescriptions: [{ TargetHealth: {} }] },
      { TargetHealthDescriptions: [{}] },
      { TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] },
    ]
    let index = 0
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: () => {
          const response = responses[index]
          index++
          return response
        },
      },
      async ({ logs, monitor }) => {
        const emitted: unknown[] = []
        monitor.on('state', (state) => {
          emitted.push(state)
        })
        await monitor.start()
        await waitUntil(() => emitted.length === responses.length)
        monitor.stop()

        assert.deepEqual(emitted, [null, null, null, null, 'healthy'])
        assert.lengthOf(logs.errors(), 0)
      }
    )
  })

  test('emits null and keeps polling when the health request throws', async ({ assert }) => {
    let calls = 0
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: () => {
          calls++
          if (calls === 1) {
            throw new Error('throttled')
          }
          return healthyTarget()
        },
      },
      async ({ logs, monitor }) => {
        const emitted: unknown[] = []
        monitor.on('state', (state) => {
          emitted.push(state)
        })
        await monitor.start()
        await waitUntil(() => emitted.length >= 2)
        monitor.stop()

        assert.deepEqual(emitted.slice(0, 2), [null, 'healthy'])
        assert.deepEqual(logMessages(logs.errors()), ['Error checking target health'])
        assert.equal(loggedError(logs.errors()[0]), 'throttled')
      }
    )
  })

  test('cancels the first poll when stopped before it runs', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: healthyTarget,
      },
      async ({ aws, monitor }) => {
        let emitted = false
        monitor.on('state', () => {
          emitted = true
        })
        await monitor.start()
        monitor.stop()
        await delay(80)

        assert.isFalse(emitted)
        assert.lengthOf(aws.inputs, 0)
        assert.lengthOf(aws.destroyed, 0)
      }
    )
  })

  test('does not schedule another poll when stopped during a health check', async ({ assert }) => {
    let entered = false
    let releaseCheck = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })

    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: async () => {
          entered = true
          await gate
          return healthyTarget()
        },
      },
      async ({ aws, monitor }) => {
        try {
          await monitor.start()
          await waitUntil(() => entered)
          const client = monitor.client
          monitor.stop()
          releaseCheck()
          await delay(80)

          assert.lengthOf(aws.inputs, 1)
          assert.include(aws.destroyed, client)
        } finally {
          releaseCheck()
        }
      }
    )
  })

  test('destroys the client and cancels the next poll', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: healthyMetadata,
        health: healthyTarget,
      },
      async ({ aws, monitor }) => {
        const pending = waitForState(monitor)
        await monitor.start()
        await pending
        const client = monitor.client

        monitor.stop()
        assert.include(aws.destroyed, client)
        const calls = aws.inputs.length
        monitor.stop()
        await delay(80)

        assert.lengthOf(aws.inputs, calls)
      }
    )
  })

  test('stop is safe before start', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
      },
      async ({ aws, monitor }) => {
        monitor.stop()
        assert.lengthOf(aws.destroyed, 0)
        assert.lengthOf(aws.inputs, 0)
      }
    )
  })

  for (const failure of metadataFailures) {
    test(`does not poll when ${failure.name}`, async ({ assert }) => {
      await withMonitor(
        {
          targetGroupArn,
          ecsMetadataUrl,
          fetch: (call) => {
            if (call.url === failure.url) {
              return new Response('no', { status: failure.status })
            }
            return healthyMetadata(call)
          },
          health: healthyTarget,
        },
        async ({ fetchMock, aws, logs, monitor }) => {
          let emitted = false
          monitor.on('state', () => {
            emitted = true
          })
          await monitor.start()
          await delay(60)

          assert.deepEqual(logMessages(logs.errors()), [
            failure.label,
            'Initialization failed',
            'Failed to start polling',
          ])
          assert.equal(loggedError(logs.errors()[0]), failure.error)
          assert.lengthOf(fetchMock.calls, failure.calls)
          assert.lengthOf(aws.inputs, 0)
          assert.lengthOf(logs.debugs(), 0)
          assert.isFalse(emitted)
        }
      )
    })
  }

  test('does not poll when the token request throws', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: () => {
          throw new Error('network down')
        },
        health: healthyTarget,
      },
      async ({ fetchMock, aws, logs, monitor }) => {
        await monitor.start()
        await delay(60)

        assert.deepEqual(logMessages(logs.errors()), [
          'Failed to get IMDSv2 token',
          'Initialization failed',
          'Failed to start polling',
        ])
        assert.equal(loggedError(logs.errors()[0]), 'network down')
        assert.lengthOf(fetchMock.calls, 1)
        assert.lengthOf(aws.inputs, 0)
      }
    )
  })

  test('does not poll when the identity document is not json', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        ecsMetadataUrl,
        fetch: (call) => {
          if (call.url === `${metadataUrl}/dynamic/instance-identity/document`) {
            return new Response('not-json', { status: 200 })
          }
          return healthyMetadata(call)
        },
        health: healthyTarget,
      },
      async ({ aws, logs, monitor }) => {
        await monitor.start()
        await delay(60)

        assert.equal(logMessages(logs.errors())[0], 'Failed to get region')
        assert.isAbove(loggedError(logs.errors()[0]).length, 0)
        assert.lengthOf(aws.inputs, 0)
        assert.lengthOf(logs.debugs(), 0)
      }
    )
  })

  test('does not poll when the ecs metadata address is unset', async ({ assert }) => {
    await withMonitor(
      {
        targetGroupArn,
        fetch: (call) => {
          if (call.url === 'undefined') {
            return new Response('missing', { status: 404 })
          }
          return healthyMetadata(call)
        },
        health: healthyTarget,
      },
      async ({ fetchMock, aws, logs, monitor }) => {
        await monitor.start()
        await delay(60)

        assert.equal(fetchMock.calls[3]?.url, 'undefined')
        assert.equal(logMessages(logs.errors())[0], 'Failed to get host port')
        assert.equal(loggedError(logs.errors()[0]), 'ECS metadata request failed: 404')
        assert.lengthOf(aws.inputs, 0)
      }
    )
  })

  for (const missingPort of missingPorts) {
    test(`does not poll when ${missingPort.name}`, async ({ assert }) => {
      await withMonitor(
        {
          targetGroupArn,
          ecsMetadataUrl,
          fetch: (call) => {
            if (call.url === ecsMetadataUrl) {
              return Response.json(missingPort.body)
            }
            return healthyMetadata(call)
          },
          health: healthyTarget,
        },
        async ({ aws, logs, monitor }) => {
          await monitor.start()
          await delay(60)

          assert.deepEqual(logMessages(logs.errors()), [
            'Initialization failed',
            'Failed to start polling',
          ])
          assert.equal(loggedError(logs.errors()[0]), 'No valid host port found')
          assert.lengthOf(aws.inputs, 0)
          assert.lengthOf(logs.debugs(), 0)
        }
      )
    })
  }

  for (const blank of uninitialized) {
    test(`keeps polling without a state when ${blank.name}`, async ({ assert }) => {
      await withMonitor(
        {
          targetGroupArn,
          ecsMetadataUrl,
          fetch: (call) => {
            if (call.url === blank.url) {
              return blank.response()
            }
            return healthyMetadata(call)
          },
          health: healthyTarget,
        },
        async ({ aws, logs, monitor }) => {
          let emitted = false
          monitor.on('state', () => {
            emitted = true
          })
          await monitor.start()
          await waitUntil(() => logMessages(logs.errors()).length >= 2)
          monitor.stop()

          assert.isFalse(emitted)
          assert.lengthOf(aws.inputs, 0)
          assert.include(logMessages(logs.debugs()), blank.debug)
          assert.include(logMessages(logs.debugs()), 'Polling started')
          assert.include(logMessages(logs.errors()), 'Error in target health check')
          assert.include(
            loggedError(logs.errors()[0]),
            'Region, port, or instanceId not initialized'
          )
        }
      )
    })
  }
})

async function withMonitor(
  handlers: MonitorHandlers,
  run: (ctx: Doubles & { monitor: Ec2TargetGroupMonitor }) => Promise<void>
) {
  const { config, ...options } = handlers
  await withDoubles(options, async (doubles) => {
    const monitor = new Ec2TargetGroupMonitor(monitorConfig(config))
    try {
      await run({ ...doubles, monitor })
    } finally {
      monitor.stop()
    }
  })
}
