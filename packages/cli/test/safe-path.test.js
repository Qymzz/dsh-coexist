import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { assertSafePackageName, resolveInside } from '../src/safe-path.js'

test('assertSafePackageName accepts normal and scoped package names', () => {
  assert.equal(assertSafePackageName('dsh-demo'), 'dsh-demo')
  assert.equal(assertSafePackageName('@scope/dsh-demo'), '@scope/dsh-demo')
  assert.equal(assertSafePackageName('a.b_c-1'), 'a.b_c-1')
})

test('assertSafePackageName rejects path traversal and malformed names', () => {
  for (const name of [
    '../escape',
    '../../escape',
    '..\\escape',
    '@scope/../../escape',
    '@scope/..',
    '/absolute',
    'C:\\Windows',
    'a/b/c',
    '',
    '   ',
    '.hidden',
    '_private',
    'a'.repeat(215),
  ]) {
    assert.throws(() => assertSafePackageName(name), /Invalid package name/, String(name))
  }
})

test('resolveInside keeps normal names and rejects escapes', () => {
  const root = path.resolve('/tmp/coexist/plugins')
  assert.equal(resolveInside(root, 'dsh-demo'), path.join(root, 'dsh-demo'))
  assert.equal(resolveInside(root, '@scope/dsh-demo'), path.join(root, '@scope', 'dsh-demo'))

  for (const name of ['..', '../escape', 'a/../../escape', '@scope/../../escape']) {
    assert.throws(() => resolveInside(root, name), /Path escapes/, String(name))
  }
})
