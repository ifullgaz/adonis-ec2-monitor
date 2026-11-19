import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'

test.group('package entry', () => {
  test('exports the public runtime api', async ({ assert }) => {
    const entry = await import('../index.js')
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { name: string; exports: Record<string, string> }
    const stub = await readFile(join(entry.stubsRoot, 'config.stub'), 'utf8')

    assert.deepEqual(Object.keys(entry).sort(), ['configure', 'defineConfig', 'stubsRoot'])
    assert.isFunction(entry.configure)
    assert.isFunction(entry.defineConfig)
    assert.deepEqual(manifest.exports, {
      '.': './build/index.js',
      './provider': './build/providers/provider.js',
      './types': './build/src/types/types.js',
    })
    assert.include(stub, `from '${manifest.name}'`)
    assert.include(stub, "metadataUrl: 'http://169.254.169.254/latest'")
    assert.include(stub, 'pollInterval: 5000')
    assert.include(stub, 'pollJitter: 1000')
  })
})
