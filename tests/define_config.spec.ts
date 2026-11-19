import { test } from '@japa/runner'
import { defineConfig } from '../src/define_config.js'

test.group('defineConfig', () => {
  test('returns the same config reference', ({ assert }) => {
    const config = {
      metadataUrl: 'http://169.254.169.254/latest',
      pollInterval: 5000,
      pollJitter: 1000,
    }

    const defined = defineConfig(config)

    assert.strictEqual(defined, config)
    assert.equal(defined.metadataUrl, 'http://169.254.169.254/latest')
    assert.equal(defined.pollInterval, 5000)
    assert.equal(defined.pollJitter, 1000)
  })
})
