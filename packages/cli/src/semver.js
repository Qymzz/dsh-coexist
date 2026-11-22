const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/

function parseVersion(text) {
  const match = String(text ?? '').trim().match(VERSION_RE)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    precision: [match[1], match[2], match[3]].filter((part) => part !== undefined).length,
    prerelease: match[4] ?? null,
  }
}

export function compareVersions(leftText, rightText) {
  const left = parseVersion(leftText)
  const right = parseVersion(rightText)
  if (!left || !right) return null

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }

  if (!left.prerelease && right.prerelease) return 1
  if (left.prerelease && !right.prerelease) return -1
  if (!left.prerelease && !right.prerelease) return 0
  if (left.prerelease === right.prerelease) return 0
  return left.prerelease < right.prerelease ? -1 : 1
}

function atLeast(version, bound) {
  return compareVersions(version, bound) >= 0
}

function below(version, bound) {
  return compareVersions(version, bound) < 0
}

function tokenMatches(versionText, token) {
  if (token === '*' || token.toLowerCase() === 'x') return true

  const match = token.match(COMPARATOR_RE)
  if (!match) return true

  const operator = match[1] ?? '='
  const parts = [match[2], match[3], match[4]].filter((part) => part !== undefined)
  const baseText = parts.join('.') + (match[5] ? `-${match[5]}` : '')
  const base = parseVersion(baseText)
  if (!base) return true

  if (operator === '>=') return atLeast(versionText, baseText)
  if (operator === '>') return compareVersions(versionText, baseText) > 0
  if (operator === '<=') return compareVersions(versionText, baseText) <= 0
  if (operator === '<') return below(versionText, baseText)

  if (operator === '^') {
    const upper = upperForCaret(base)
    return atLeast(versionText, lowerOf(base)) && below(versionText, upper)
  }

  if (operator === '~') {
    const upper = upperForTilde(base)
    return atLeast(versionText, lowerOf(base)) && below(versionText, upper)
  }

  // 精确版本：只写 1 或 1.2 时按 SemVer 视为范围。
  if (base.precision === 1) {
    return atLeast(versionText, `${base.major}.0.0`) && below(versionText, `${base.major + 1}.0.0`)
  }
  if (base.precision === 2) {
    return (
      atLeast(versionText, `${base.major}.${base.minor}.0`) &&
      below(versionText, `${base.major}.${base.minor + 1}.0`)
    )
  }
  return compareVersions(versionText, baseText) === 0
}

function lowerOf(base) {
  return `${base.major}.${base.minor}.${base.patch}${base.prerelease ? `-${base.prerelease}` : ''}`
}

function upperForCaret(base) {
  if (base.major > 0) return `${base.major + 1}.0.0`
  if (base.precision === 1) return '1.0.0'
  if (base.minor > 0) return `0.${base.minor + 1}.0`
  return `0.0.${base.patch + 1}`
}

function upperForTilde(base) {
  if (base.precision >= 2) return `${base.major}.${base.minor + 1}.0`
  return `${base.major + 1}.0.0`
}

/**
 * 判断版本是否落在 npm 风格的 semver 范围内。
 * 支持：精确版本、1 / 1.2 这类部分版本、*、^、~、>=、>、<=、<、||。
 * 不支持 hyphen、预发布标签的完整语义；遇到无法解析的 token 时放行（fail-open）。
 */
export function satisfies(versionText, rangeText) {
  const version = String(versionText ?? '').trim()
  if (!parseVersion(version)) return false

  const range = String(rangeText ?? '').trim()
  if (range === '' || range === '*' || range.toLowerCase() === 'x') return true

  return range.split('||').some((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return true
    return tokens.every((token) => tokenMatches(version, token))
  })
}

/**
 * 取一个范围的“最低可满足版本”，用于生成受控 peer override。
 * 多段（||）取其中最高的最低版本；无法解析时返回 null。
 */
export function minVersionForRange(rangeText) {
  const range = String(rangeText ?? '').trim()
  if (!range) return null

  const versions = []
  for (const alternative of range.split('||')) {
    for (const token of alternative.trim().split(/\s+/).filter(Boolean)) {
      const match = token.match(COMPARATOR_RE)
      if (!match) continue
      const parts = [match[2], match[3], match[4]].filter((part) => part !== undefined)
      if (parts.length === 0) continue
      versions.push(`${Number(match[2])}.${Number(match[3] ?? 0)}.${Number(match[4] ?? 0)}`)
      break
    }
  }

  if (versions.length === 0) return null
  versions.sort((left, right) => compareVersions(right, left))
  return versions[0]
}
