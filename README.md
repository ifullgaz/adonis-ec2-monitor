# @ifullgaz/adonis-ec2-monitor

AdonisJS v7 monitor for one ECS task running on EC2. The package asks Elastic Load Balancing whether **this** task’s target is healthy, and emits that state on a timer. Application code uses the state to start or pause work that the load balancer does not control.

Requires Node.js 24 or newer and `@adonisjs/core` 7.

## The deployment this is for

An ECS service on the **EC2** launch type, attached to an Application Load Balancer or Network Load Balancer. The target group’s target type is **instance**. The task’s network mode is **bridge** (or host), so ECS registers the target as the EC2 instance id plus the **host port** Docker published for the container.

From inside the container that registration is not obvious:

- The instance id and the region come from the instance metadata service (IMDSv2), at `http://169.254.169.254/latest`.
- The host port comes from the ECS container metadata endpoint. The ECS agent sets `ECS_CONTAINER_METADATA_URI_V4`. This package reads `Ports[0].HostPort`, the first port mapping on the container.
- The target group comes from the `TARGET_GROUP_ARN` environment variable on the task.

Each poll calls `DescribeTargetHealth` with that instance id, that host port, and that target group. The load balancer’s answer is one of `initial`, `healthy`, `unhealthy`, `unused`, `draining`, or `unavailable`. The monitor emits it as a `state` event.

This matches the ECS dynamic port mapping path. A target group of type `ip` (typical for `awsvpc` and Fargate) registers a private address, not an instance id, so those tasks are outside what this monitor queries.

## Why the process needs the state

The load balancer already stops sending new requests when a target is `draining` or `unhealthy`. The Adonis process does not hear that on its own. Schedulers, queues, bus subscribers, and anything else started at boot keep running until something inside the process reacts.

Listen for `state` when this task should:

- Wait until the target is `healthy` before starting work that should run only while the load balancer considers the task in service. During a rolling deploy the target stays `initial` until the health checks pass. A consumer started at boot takes work on a task that is not receiving traffic yet, and on a task that ECS will stop if the checks never pass.
- Pause that work when the state becomes `draining`. ECS deregisters the target and then waits for the target group’s deregistration delay. In that window the HTTP server is still up and in-flight requests finish. Background work is not part of that drain unless the process stops it.
- Treat `unhealthy` as loss of traffic. The checks failed, or the instance is stopped. The same pause used for `draining` applies while the task is still alive.
- Ignore a `null` state. The API call failed, the target was missing from the response, or `TargetHealth.State` was empty. The previous decision stays in force until a later poll returns a state.

The monitor reports the state. The listener closes work the load balancer cannot see: schedulers, queues, and consumers. The HTTP server stays up so in-flight requests can finish during `draining`.

With `TARGET_GROUP_ARN` unset, `start()` returns immediately. Local and CI processes boot without IMDS, ECS metadata, or AWS credentials. An unset variable is the off switch. Set it on the ECS task definition and leave it unset everywhere else.

## Install

The package is published to GitHub Packages.

```sh
npm install @ifullgaz/adonis-ec2-monitor
```

Or, using ace to configure the package immediately:

```sh
node ace add @ifullgaz/adonis-ec2-monitor
```

Point the `@ifullgaz` scope at GitHub Packages in an `.npmrc` next to the application `package.json`:

```text
@ifullgaz:registry=https://npm.pkg.github.com
```

`@adonisjs/core` must already be installed. `@adonisjs/assembler` is an optional peer dependency. The configure command needs it to edit the application.

`@aws-sdk/client-elastic-load-balancing-v2` is a dependency of this package. Credentials come from the [default AWS SDK chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html). On ECS that is the task role.

## Configure

From the application root:

```sh
node ace configure @ifullgaz/adonis-ec2-monitor
```

This creates `config/ec2_monitor.ts` from the package stub. An existing file is left unchanged. Pass `--force` to overwrite it. The command does not edit `adonisrc.ts`. Register the provider yourself:

```ts
{
  providers: [
    () => import('@ifullgaz/adonis-ec2-monitor/provider'),
  ]
}
```

```ts
import { defineConfig } from '@ifullgaz/adonis-ec2-monitor'

export default defineConfig({
  metadataUrl: 'http://169.254.169.254/latest',
  pollInterval: 5000,
  pollJitter: 1000,
})
```

`defineConfig` returns the same object. It exists so the config file is type-checked.

| Option | Meaning |
| --- | --- |
| `metadataUrl` | IMDSv2 base URL, without a trailing path. The monitor appends `/api/token`, `/meta-data/instance-id`, and `/dynamic/instance-identity/document`. |
| `pollInterval` | Base delay between polls, in milliseconds. |
| `pollJitter` | Extra delay, in milliseconds. Each wait is `pollInterval + Math.random() * pollJitter`, so the stub waits between 5 and 6 seconds. |

Jitter spreads `DescribeTargetHealth` calls when many tasks of the same service start together and would otherwise poll in step.

On the task definition:

| Variable | Role |
| --- | --- |
| `TARGET_GROUP_ARN` | Target group to query. Unset means the monitor does not start. |
| `ECS_CONTAINER_METADATA_URI_V4` | Set by the ECS agent. The monitor reads the first host port from it. |

The task role needs `elasticloadbalancing:DescribeTargetHealth`. That action does not support resource-level permissions, so the resource is `*`.

```json
{
  "Effect": "Allow",
  "Action": "elasticloadbalancing:DescribeTargetHealth",
  "Resource": "*"
}
```

Bridge mode reaches IMDS from a network namespace behind the instance, so the instance metadata hop limit has to be at least **2**. A hop limit of 1 answers the instance and drops the container’s token request. The monitor puts an IMDSv2 token with a TTL of 21600 seconds (6 hours) and uses it only while reading the instance id and the region at startup. Later polls use the AWS SDK, which refreshes its own credentials.

The first entry in the container’s port mappings has to be the port registered in the target group. The monitor queries that host port. The value has to be a non-zero number. A missing port fails startup of the poll loop.

## What the provider starts

`Ec2TargetGroupMonitorProvider` registers a container singleton named `ec2TargetGroupMonitor`. The singleton is created the first time it is resolved.

On `ready` the provider resolves that singleton and calls `start()`, and it blocks the `ready` hook until `start()` finishes. `start()` reads the token, the instance id, the region, and the host port before it schedules the first poll. Each IMDS call aborts after 5 seconds. The ECS metadata call has no timeout, so a hung agent endpoint holds `ready` until it returns. A metadata or identity failure is logged and the application still finishes booting. The poll loop is not scheduled in that case.

When `TARGET_GROUP_ARN` is unset, `start()` returns before it reads config or the network. A missing `config/ec2_monitor.ts` only matters once the ARN is set and initialization runs.

The first `state` event is one interval after startup, not during `start()`. Subscribers registered from another provider’s `boot` or `ready` still see it. The event is not replayed. A listener attached later sees the next poll only.

On application shutdown the provider calls `stop()`, which clears the pending timer and destroys the ELB client.

The client is created on the first poll, with the region taken from the instance identity document. The SDK default chain supplies credentials and the endpoint.

## States

`DescribeTargetHealth` returns these `TargetHealth.State` values. The monitor emits the string unchanged.

| State | What the load balancer is saying | What the process usually does |
| --- | --- | --- |
| `initial` | The target is being registered, or the first checks are still running. | Keep background work stopped. |
| `healthy` | Checks are passing and the target can receive traffic. | Start work that should follow traffic. |
| `unhealthy` | Checks failed, or the target is stopped. | Pause that work. |
| `draining` | The target is deregistering and the deregistration delay is running. | Pause that work. Leave the HTTP server up so in-flight requests finish. |
| `unused` | Nothing is sending this target traffic: the group is not on a listener, the Availability Zone is disabled, or the target is not in use. | Treat it like a task that should not take background work. |
| `unavailable` | Health is not available. | Same as a `null` event: keep the previous decision. |

A poll that throws, an empty description list, or a missing `State` emits `null`. The error is logged and the next poll is still scheduled. One failed call does not stop the loop.

## Listen

Resolve the singleton from a provider `ready` hook and subscribe to `state`. The first event arrives one poll interval later, so a listener registered while the application is still starting still receives it.

```ts
import type { ApplicationService } from '@adonisjs/core/types'

export default class TrafficGateProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    const monitor = await this.app.container.make('ec2TargetGroupMonitor')

    monitor.on('state', (state: string | null) => {
      if (state === 'healthy') {
        // Start schedulers, queues, and consumers.
        return
      }

      if (
        state === 'initial' ||
        state === 'draining' ||
        state === 'unhealthy' ||
        state === 'unused'
      ) {
        // Stop taking new work. Leave the HTTP server running.
      }
    })
  }
}
```

`healthy` is the signal to run background work. `initial`, `draining`, `unhealthy`, and `unused` are the signals to stop taking it. `null` and `unavailable` leave the current decision in place.

The binding is typed on the container as `ec2TargetGroupMonitor`. The class is a Node.js `EventEmitter`. `on('state', listener)` and `off('state', listener)` subscribe and unsubscribe. Calling `start()` again is not required. The provider already did it.

## Imports

| Specifier | Exports |
| --- | --- |
| `@ifullgaz/adonis-ec2-monitor` | `configure`, `defineConfig`, `stubsRoot` |
| `@ifullgaz/adonis-ec2-monitor/provider` | default export `Ec2TargetGroupMonitorProvider` |
| `@ifullgaz/adonis-ec2-monitor/types` | `EC2MonitorConfig` |

```ts
import { defineConfig } from '@ifullgaz/adonis-ec2-monitor'
import type { EC2MonitorConfig } from '@ifullgaz/adonis-ec2-monitor/types'
```

`stubsRoot` is the directory of the package stubs. The configure hook uses it. Application code does not need it.

`EC2MonitorConfig` is `{ metadataUrl: string, pollInterval: number, pollJitter: number }`.

## Contribute

Node.js 24 or newer is required. Install dependencies from this package directory:

```sh
npm install
```

You can also build the Node 24 image and run commands in that container. `docker-compose.yml` mounts this directory at `/app`.

```sh
docker compose up -d
docker exec -it adonis-ec2-monitor-adonis-ec2-monitor-1 npm install
```

| Script | What it does |
| --- | --- |
| `npm run lint` | ESLint, using `@adonisjs/eslint-config` |
| `npm run format` | Prettier, using `@adonisjs/prettier-config` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run quick:test` | Japa tests |
| `npm test` | Lint, then tests with c8 coverage |
| `npm run build` | Lint, compile with `tsc`, copy stubs |

Pull request events run lint, typecheck, and tests on Node.js 24. Tests also run on Windows.

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`). Releases are cut with `release-it` and the Angular changelog preset.

The license is MIT.
