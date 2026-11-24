import path from 'node:path'

/**
 * npm 包名允许：普通名或 @scope/name。
 * 首字符必须是字母或数字，后面允许字母、数字、点、下划线、连字符。
 * 大小写保持兼容（老包可能有大写），但拒绝 `.`、`..`、路径分隔符和绝对路径。
 */
const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_PACKAGE_NAME_LENGTH = 214

/**
 * 校验包名，防止 `../`、`..\\`、绝对路径等把后续 path.join 带出目标目录。
 * 所有来自 package.json / npm view / 用户输入的包名，在拼路径前都要过这一层。
 */
export function assertSafePackageName(name) {
  const text = String(name ?? '')
  if (text.length === 0 || text.length > MAX_PACKAGE_NAME_LENGTH || !PACKAGE_NAME_RE.test(text)) {
    throw new Error(`Invalid package name: ${JSON.stringify(text)}`)
  }
  return text
}

/**
 * 把 segments 拼到 root 下，并确认结果仍在 root 内。
 * 用于所有会删除或覆盖目录的路径，作为 assertSafePackageName 之外的第二道防线。
 */
export function resolveInside(root, ...segments) {
  const base = path.resolve(root)
  const target = path.resolve(base, ...segments)
  const relative = path.relative(base, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes ${base}: ${target}`)
  }
  return target
}
