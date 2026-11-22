import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runReport } from '../src/commands.js'
import { renderReport } from '../src/report.js'

async function makeHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coexist-cli-report-'))
}

test('report command reads the plugin runtime report', async () => {
  const home = await makeHome()
  try {
    const file = path.join(home, 'coexist', 'report.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      `${JSON.stringify(
        {
          generatedAt: '2026-11-22T08:00:00.000Z',
          mode: 'fallback',
          tools: {
            aliases: [
              { name: 'memory_search', alias: 'memory_search__coexist1', calls: 2 },
            ],
            fallbacks: [{ tool: 'memory_search', error: 'A down', at: '2026-11-22T08:00:01.000Z' }],
            routes: [
              { tool: 'memory_search', target: 'backup', reason: 'args', at: '2026-11-22T08:00:02.000Z' },
            ],
          },
          serviceConflicts: [
            { service: 'demo-service', existing: 'plugin-a', incoming: 'plugin-b' },
          ],
          failures: [{ plugin: 'bad-plugin', state: 'failed', kind: 'contract', error: 'boom' }],
          pending: [
            { plugin: 'waiting-plugin', state: 'pending', missing: ['missingService'] },
          ],
          eventHooks: [
            { event: 'demo/event', owners: ['plugin-a', 'plugin-b'], listeners: 2, prepend: 0 },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const result = await runReport({ home })
    assert.equal(result.exists, true)

    const text = renderReport(result)
    assert.match(text, /Mode: fallback/)
    assert.match(text, /memory_search -> memory_search__coexist1 \(calls=2\)/)
    assert.match(text, /Fallbacks: 1/)
    assert.match(text, /memory_search: A down/)
    assert.match(text, /Routes: 1/)
    assert.match(text, /memory_search -> backup \(args\)/)
    assert.match(text, /demo-service: plugin-a vs plugin-b/)
    assert.match(text, /bad-plugin \[contract\]: boom/)
    assert.match(text, /waiting-plugin \(pending\) missing: missingService/)
    assert.match(text, /demo\/event: plugin-a, plugin-b/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('missing runtime report renders a hint', async () => {
  const home = await makeHome()
  try {
    const result = await runReport({ home })
    assert.equal(result.exists, false)
    assert.match(renderReport(result), /No runtime report/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
