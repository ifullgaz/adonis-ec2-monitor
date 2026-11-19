import { type EventEmitter } from 'node:events'
import logger from '@adonisjs/core/services/logger'
import {
  type DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  type DescribeTargetHealthCommandInput,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { type EC2MonitorConfig } from '../../src/types/types.js'

export const metadataUrl = 'http://169.254.169.254/latest'
export const ecsMetadataUrl = 'http://169.254.170.2/v4/task'
export const targetGroupArn =
  'arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/app/abc'
export const instanceId = 'i-0abc123'
export const instanceRegion = 'eu-west-1'
export const hostPort = 8080
export const imdsToken = 'imds-token'

const envKeys = ['TARGET_GROUP_ARN', 'ECS_CONTAINER_METADATA_URI_V4'] as const

export type FetchCall = {
  url: string
  method: string
  headers: Headers
  signal: AbortSignal | undefined
}

export type TargetHealth = {
  TargetHealthDescriptions?: Array<{
    TargetHealth?: {
      State?: string
    }
  }>
}

export type LogCall = {
  level: 'error' | 'debug'
  args: unknown[]
}

export type LogCapture = {
  calls: LogCall[]
  errors: () => LogCall[]
  debugs: () => LogCall[]
  restore: () => void
}

export type FetchDouble = {
  calls: FetchCall[]
  restore: () => void
}

export type AwsDouble = {
  inputs: DescribeTargetHealthCommandInput[]
  commands: DescribeTargetHealthCommand[]
  destroyed: object[]
  restore: () => void
}

export type Doubles = {
  fetchMock: FetchDouble
  aws: AwsDouble
  logs: LogCapture
}

export type DoubleOptions = {
  fetch?: (call: FetchCall) => Response | Promise<Response>
  health?: (input: DescribeTargetHealthCommandInput) => TargetHealth | Promise<TargetHealth>
  targetGroupArn?: string
  ecsMetadataUrl?: string
}

export function monitorConfig(overrides: Partial<EC2MonitorConfig> = {}): EC2MonitorConfig {
  return {
    metadataUrl,
    pollInterval: 25,
    pollJitter: 0,
    ...overrides,
  }
}

export function healthyMetadata(call: FetchCall, baseUrl = metadataUrl) {
  switch (call.url) {
    case `${baseUrl}/api/token`:
      return new Response(imdsToken)
    case `${baseUrl}/meta-data/instance-id`:
      return new Response(instanceId)
    case `${baseUrl}/dynamic/instance-identity/document`:
      return Response.json({ region: instanceRegion })
    case ecsMetadataUrl:
      return Response.json({
        Ports: [{ HostPort: hostPort }, { HostPort: 9090 }],
      })
    default:
      throw new Error(`Unexpected fetch ${call.url}`)
  }
}

export function healthyTarget(): TargetHealth {
  return {
    TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }],
  }
}

export function logMessages(calls: LogCall[]) {
  return calls.map((call) => {
    const message = call.args.find((arg) => typeof arg === 'string')
    return typeof message === 'string' ? message : ''
  })
}

export function loggedError(call: LogCall) {
  const error = call.args[0]
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message)
  }
  return ''
}

export function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function waitForState(emitter: EventEmitter, timeout = 1000) {
  let onState: (state: unknown) => void = () => {}
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener('state', onState)
      reject(new Error('Timed out waiting for a target health state'))
    }, timeout)
    onState = (state: unknown) => {
      clearTimeout(timer)
      resolve(state)
    }
    emitter.once('state', onState)
  })
  void promise.catch(() => {
    return undefined
  })
  return promise
}

export async function waitUntil(predicate: () => boolean, timeout = 1000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) {
      throw new Error('Timed out waiting for condition')
    }
    await delay(5)
  }
}

export async function resolvedRegion(client: ElasticLoadBalancingV2Client) {
  return client.config.region()
}

export function isolateEnv() {
  const previous = new Map<string, string | undefined>()
  for (const key of envKeys) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }

  return () => {
    for (const key of envKeys) {
      const value = previous.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

export async function withDoubles<T>(
  options: DoubleOptions,
  run: (doubles: Doubles) => Promise<T>
) {
  const restoreEnv = isolateEnv()
  if (options.targetGroupArn !== undefined) {
    process.env.TARGET_GROUP_ARN = options.targetGroupArn
  }
  if (options.ecsMetadataUrl !== undefined) {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = options.ecsMetadataUrl
  }

  const fetchMock = installFetch(async (call) => {
    if (!options.fetch) {
      throw new Error(`Unexpected fetch ${call.url}`)
    }
    return options.fetch(call)
  })
  const aws = installTargetHealth(async (input) => {
    if (!options.health) {
      throw new Error('Target health was not expected')
    }
    return options.health(input)
  })
  const logs = captureLogger()

  try {
    return await run({ fetchMock, aws, logs })
  } finally {
    fetchMock.restore()
    aws.restore()
    logs.restore()
    restoreEnv()
  }
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (...[input, init]: Parameters<typeof fetch>) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      signal: init?.signal ?? undefined,
    }
    calls.push(call)
    return handler(call)
  }) as typeof globalThis.fetch

  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

function installTargetHealth(
  handler: (input: DescribeTargetHealthCommandInput) => TargetHealth | Promise<TargetHealth>
) {
  const inputs: DescribeTargetHealthCommandInput[] = []
  const commands: DescribeTargetHealthCommand[] = []
  const destroyed: object[] = []
  const prototype = ElasticLoadBalancingV2Client.prototype as unknown as {
    send: (command: DescribeTargetHealthCommand) => Promise<TargetHealth>
    destroy: () => void
  }
  const originalSend = prototype.send
  const originalDestroy = prototype.destroy

  prototype.send = async (command) => {
    commands.push(command)
    inputs.push(command.input)
    return handler(command.input)
  }
  prototype.destroy = function destroy(this: object) {
    destroyed.push(this)
    originalDestroy.call(this)
  }

  return {
    inputs,
    commands,
    destroyed,
    restore() {
      prototype.send = originalSend
      prototype.destroy = originalDestroy
    },
  }
}

function captureLogger(): LogCapture {
  const calls: LogCall[] = []
  const originalError = logger.error
  const originalDebug = logger.debug
  logger.error = ((...args: unknown[]) => {
    calls.push({ level: 'error', args })
  }) as typeof logger.error
  logger.debug = ((...args: unknown[]) => {
    calls.push({ level: 'debug', args })
  }) as typeof logger.debug

  return {
    calls,
    errors() {
      return calls.filter((call) => call.level === 'error')
    },
    debugs() {
      return calls.filter((call) => call.level === 'debug')
    },
    restore() {
      logger.error = originalError
      logger.debug = originalDebug
    },
  }
}
