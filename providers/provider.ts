import { type ApplicationService } from '@adonisjs/core/types'
import Ec2TargetGroupMonitor from '../src/core/ec2_target_group_monitor.js'
import type { EC2MonitorConfig } from '../src/types/types.js'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    ec2TargetGroupMonitor: Ec2TargetGroupMonitor
  }
}

export default class Ec2TargetGroupMonitorProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('ec2TargetGroupMonitor', async () => {
      const config = (await this.app.config.get('ec2_monitor')) as EC2MonitorConfig
      return new Ec2TargetGroupMonitor(config)
    })
  }

  async ready() {
    const monitor = await this.app.container.make('ec2TargetGroupMonitor')
    await monitor.start()
    this.app.terminating(async () => {
      monitor.stop()
    })
  }
}
