import { EventEmitter } from 'node:events'
import logger from '@adonisjs/core/services/logger'
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetHealthCommand,
  type DescribeTargetHealthCommandInput,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import type { EC2MonitorConfig } from '../types/types.js'

export default class Ec2TargetGroupMonitor extends EventEmitter {
  private token: string = ''
  private instanceId: string | undefined = undefined
  private region: string | undefined = undefined
  private port: number = 0
  private interval: NodeJS.Timeout | null = null
  private stopped = false
  private targetGroupArn: string | undefined = process.env.TARGET_GROUP_ARN
  private _client!: ElasticLoadBalancingV2Client

  constructor(private config: EC2MonitorConfig) {
    super()
  }

  get client(): ElasticLoadBalancingV2Client {
    if (!this._client) {
      this._client = new ElasticLoadBalancingV2Client({ region: this.region })
    }
    return this._client
  }

  private async getToken(): Promise<string> {
    try {
      const tokenResponse = await fetch(`${this.config.metadataUrl}/api/token`, {
        method: 'PUT',
        headers: {
          'X-aws-ec2-metadata-token-ttl-seconds': '21600',
        },
        signal: AbortSignal.timeout(5000),
      })
      if (!tokenResponse.ok) {
        throw new Error(`Token request failed: ${tokenResponse.status}`)
      }
      return await tokenResponse.text()
    } catch (error) {
      logger.error(error, 'Failed to get IMDSv2 token')
      throw error
    }
  }

  private async getInstanceId(): Promise<string> {
    try {
      const response = await fetch(`${this.config.metadataUrl}/meta-data/instance-id`, {
        headers: {
          'X-aws-ec2-metadata-token': this.token,
        },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        throw new Error(`Instance ID request failed: ${response.status}`)
      }
      return await response.text()
    } catch (error) {
      logger.error(error, 'Failed to get instance ID')
      throw error
    }
  }

  private async getRegion(): Promise<string> {
    try {
      const response = await fetch(
        `${this.config.metadataUrl}/dynamic/instance-identity/document`,
        {
          headers: {
            'X-aws-ec2-metadata-token': this.token,
          },
          signal: AbortSignal.timeout(5000),
        }
      )
      if (!response.ok) {
        throw new Error(`Region request failed: ${response.status}`)
      }
      const document = (await response.json()) as any
      return document.region
    } catch (error) {
      logger.error(error, 'Failed to get region')
      throw error
    }
  }

  private async getHostPort(): Promise<number> {
    try {
      const response = await fetch(`${process.env.ECS_CONTAINER_METADATA_URI_V4}`)
      if (!response.ok) {
        throw new Error(`ECS metadata request failed: ${response.status}`)
      }
      const metadata = (await response.json()) as any
      return Number(metadata.Ports?.[0]?.HostPort) || 0
    } catch (error) {
      logger.error(error, 'Failed to get host port')
      throw error
    }
  }

  private async checkTargetHealth(): Promise<string | null | undefined> {
    if (!this.region || !this.port || !this.instanceId) {
      throw new Error('Region, port, or instanceId not initialized')
    }
    // const params = new DescribeTargetHealthCommandInput
    const params: DescribeTargetHealthCommandInput = {
      TargetGroupArn: this.targetGroupArn,
      Targets: [{ Id: this.instanceId, Port: this.port }],
    }
    try {
      const command = new DescribeTargetHealthCommand(params)
      const data = await this.client.send(command)
      // Check if TargetHealthDescriptions exists and has at least one entry
      if (data.TargetHealthDescriptions && data.TargetHealthDescriptions.length > 0) {
        return data.TargetHealthDescriptions[0].TargetHealth?.State ?? null
      }
    } catch (error) {
      logger.error(error, 'Error checking target health')
    }
    return null
  }

  private async pollTargetHealth() {
    // Call async method without awaiting; returns immediately
    try {
      const state = await this.checkTargetHealth()
      this.emit('state', state)
    } catch (error) {
      logger.error(error, 'Error in target health check')
    } finally {
      this.startPolling()
    }
  }

  private startPolling() {
    if (this.stopped) {
      return
    }
    this.interval = setTimeout(
      async () => {
        await this.pollTargetHealth()
      },
      this.config.pollInterval + Math.random() * this.config.pollJitter
    ) // 10-12s interval
  }

  private async initialize() {
    try {
      this.token = await this.getToken()
      this.instanceId = await this.getInstanceId()
      this.region = await this.getRegion()
      this.port = await this.getHostPort()
      if (!this.port) {
        throw new Error('No valid host port found')
      }
      logger.debug(
        `Initialized: instanceId=${this.instanceId}, region=${this.region}, port=${this.port}`
      )
    } catch (error) {
      logger.error(error, 'Initialization failed')
      throw error
    }
  }

  async start() {
    this.stopped = false
    try {
      if (!this.targetGroupArn) {
        return
      }
      await this.initialize()
      if (this.stopped) {
        return
      }
      this.startPolling()
      logger.debug('Polling started')
    } catch (error) {
      logger.error(error, 'Failed to start polling')
    }
  }

  stop() {
    this.stopped = true
    if (this.interval) {
      clearTimeout(this.interval)
      this.interval = null
    }
    if (this._client) {
      this._client.destroy()
    }
  }
}
