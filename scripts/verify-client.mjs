/**
 * Syntax-and-registration check for the QQ settings-page client.
 *
 * ## What this verifies — and what it does not
 *
 * It verifies the *registration shape*: that `client.js` loads under a stubbed browser baseline,
 * that it registers exactly one module under the id `dsh-qq-plugin`, that the factory returns
 * `{ name, inject, apply }` with `inject` exactly `['slots']`, that `apply` runs without throwing
 * against a stubbed context, and that every disposer it hands to `ctx.effect` is callable.
 *
 * It also stubs `navigator.sendBeacon` and fires the captured 20-second watchdog callback, so the
 * client-error reporting path is exercised for real rather than merely parsed.
 *
 * ⚠️ It is **not** a visual check. Nothing here renders React, lays out CSS, or talks to a live
 * host: the component is never invoked, so no DOM, no stylesheet and no route response is
 * validated. Visual verification is unavailable from this harness and is not claimed.
 *
 * Run: node scripts/verify-client.mjs   (from the dsh-qq package directory)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/**
 * 去掉块注释后的源码。
 *
 * 静态命名检查必须看**代码**而不是**注释**：本文件的文件头注释里刻意写了
 * `dsh-wechat-plugin/client.js` 来解释那次跨插件顶层冲突，若对整份文本做子串检查，
 * 这段有价值的说明反而会被判成"还留着微信前缀"。
 *
 * 只剥块注释、不剥行注释：源码里有 `https://…` 这种含 `//` 的字面量，
 * 粗暴地按 `//` 切会把它们也砍掉。
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '')

const failures = []
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`PASS  ${label}${detail === '' ? '' : ` — ${detail}`}`)
    return
  }
  failures.push(label)
  console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, ok, ok ? JSON.stringify(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log('=== dsh-qq-plugin client.js verification ===\n')
console.log('-- 1. Static source checks --')

check('no dsh-wechat- CSS prefix remains', !code.includes('dsh-wechat'))
check('no dsh-wechat-plugin id remains', !code.includes("id: 'dsh-wechat-plugin'"))
check("PREFIX is '/.dsh-qq-plugin'", source.includes("const PREFIX = '/.dsh-qq-plugin'"))
check("no Harness client package is required as a module", !/require\(\s*'@deepseek-ai/.test(source))
check('style element id is dsh-qq-style', source.includes("getElementById('dsh-qq-style')"))

// The three behaviours below are the ones that cannot be checked by registration shape alone, and
// each exists because of a concrete host behaviour. They are asserted as source facts, not as
// runtime behaviour: there is no renderer here (see the header).
check('the bound-account list is read from GET /accounts', code.includes('request(`${PREFIX}/accounts`)'))
check(
  'login polling keys off a settled-phase blacklist, not the word running',
  code.includes('if (!loginInFlight(prev.login?.phase)) return prev') &&
    !code.includes("prev.login?.phase !== 'running'"),
)
check(
  'the settings save sends only the fields this page owns',
  code.includes('for (const key of SETTINGS_FIELDS)') &&
    !code.includes('body: JSON.stringify(state.draft)'),
)

console.log('\n-- 2. Registration under a stubbed browser baseline --')

/** The registration spec the module hands to the shell. */
let registered
/** react module ids the factory asked for. */
const requested = []
/** Watchdog timers the factory scheduled. */
const timers = []

const realGlobals = {}
const defined = ['window', 'document', 'navigator']

function defineGlobal(name, value) {
  realGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

/** Beacon payloads, so the client-error path can be observed. */
const beacons = []
/** `<style>` elements the plugin appended to head. */
const appended = []
/** Teardown events, in order, so the disposers can be observed rather than assumed. */
const disposed = []

defineGlobal('window', {
  __ModuleLoader__: { load: (spec) => { registered = spec } },
  addEventListener: () => {},
  removeEventListener: () => {},
})
defineGlobal('document', {
  documentElement: { lang: 'zh-CN' },
  getElementById: () => null,
  createElement: () => ({
    id: '',
    textContent: '',
    remove: () => disposed.push('style'),
  }),
  head: { append: (element) => appended.push(element) },
})
defineGlobal('navigator', {
  language: 'zh-CN',
  sendBeacon: (url, blob) => {
    beacons.push({ url, blob })
    return true
  },
})
// A real 20-second timer would hold the process open; capturing it also lets the test fire it.
defineGlobal('setTimeout', (callback, delay) => {
  timers.push({ callback, delay })
  return timers.length
})

try {
  await import(pathToFileURL(clientPath).href)
} catch (error) {
  check('client.js imports without throwing', false, error instanceof Error ? error.message : String(error))
}

check('module registered a spec at load time', registered !== undefined && registered !== null)
equal('registered id is dsh-qq-plugin', registered?.id, 'dsh-qq-plugin')
check('registered spec carries a factory', typeof registered?.factory === 'function')

// The factory is what receives `require`; React is the only baseline module this client uses.
const React = {
  createElement: () => ({}),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const exports_ = registered?.factory((id) => {
  requested.push(id)
  if (id === 'react') return React
  throw new Error(`unexpected module request: ${id}`)
})

console.log('\n-- 3. Factory exports --')

check('factory returned an object', typeof exports_ === 'object' && exports_ !== null)
const keys = Object.keys(exports_ ?? {}).sort()
equal('exports are exactly apply/inject/name', keys, ['apply', 'inject', 'name'])
equal('name is dsh-qq-plugin', exports_?.name, 'dsh-qq-plugin')
equal("inject is exactly ['slots']", exports_?.inject, ['slots'])
check('apply is a function', typeof exports_?.apply === 'function')
equal('factory resolved react through the injected require', requested, ['react'])

console.log('\n-- 4. Watchdog --')

equal('one 20-second watchdog timer was scheduled', timers.map((timer) => timer.delay), [20_000])
if (typeof timers[0]?.callback === 'function') {
  try {
    timers[0].callback()
  } catch (error) {
    check('watchdog callback runs without throwing', false, String(error))
  }
}
check('watchdog reported through sendBeacon', beacons.length === 1, `${beacons.length} beacon(s)`)
equal('report went to PREFIX/client-error', beacons[0]?.url, '/.dsh-qq-plugin/client-error')
let beaconBody
try {
  beaconBody = JSON.parse(await beacons[0]?.blob?.text?.())
} catch {
  beaconBody = undefined
}
equal('report shape is { scope, message, stack }', Object.keys(beaconBody ?? {}).sort(), [
  'message',
  'scope',
  'stack',
])
equal('report scope is mount', beaconBody?.scope, 'mount')

console.log('\n-- 5. apply() against a stubbed context --')

/** Slot registrations seen. */
const slotRegistrations = []
/** Slot injections seen. */
const slotInjections = []

const ctx = {
  effect: (factory) => {
    ctx.effectCalls += 1
    // `apply` returns the disposer from the effect callback, which is the plugin contract.
    ctx.effectDisposer = factory()
    return () => {}
  },
  effectCalls: 0,
  slots: {
    inject: (slot, factory) => {
      slotInjections.push(slot)
      factory()
      return () => disposed.push('slot')
    },
    register: (options, component) => {
      slotRegistrations.push({ options, component })
      return () => disposed.push('register')
    },
  },
}

let applyError
try {
  exports_.apply(ctx)
} catch (error) {
  applyError = error
}
check(
  'apply(ctx) does not throw',
  applyError === undefined,
  applyError === undefined ? '' : String(applyError),
)
equal('apply registered exactly one effect', ctx.effectCalls, 1)
equal('effect callback returned a disposer function', typeof ctx.effectDisposer, 'function')
equal('slot injected is settings.section', slotInjections, ['settings.section'])
equal('one slot registration', slotRegistrations.length, 1)
equal('registration name is settings.section', slotRegistrations[0]?.options?.name, 'settings.section')
equal("registration id is 'qq'", slotRegistrations[0]?.options?.id, 'qq')
equal('registration order stays 40', slotRegistrations[0]?.options?.order, 40)
check('registration carries a component', typeof slotRegistrations[0]?.component === 'function')
equal('registration label() is the nav entry', slotRegistrations[0]?.options?.label?.(), 'QQ')
equal('registration inject() returns an empty object', slotRegistrations[0]?.options?.inject?.(), {})

equal('one stylesheet was appended', appended.map((element) => element.id), ['dsh-qq-style'])
check(
  'the stylesheet carries the dsh-qq- class prefix',
  typeof appended[0]?.textContent === 'string' && appended[0].textContent.includes('.dsh-qq '),
)

if (typeof ctx.effectDisposer === 'function') {
  try {
    ctx.effectDisposer()
  } catch (error) {
    check('effect disposer runs without throwing', false, String(error))
  }
}
equal('disposer released the slot and removed the stylesheet', disposed, ['slot', 'style'])

// Restore the real globals so a failed check cannot leave the harness stubbed.
for (const name of ['setTimeout', ...defined]) {
  const real = realGlobals[name]
  if (real === undefined) delete globalThis[name]
  else Object.defineProperty(globalThis, name, real)
}

console.log('\n-- 6. Copy tables --')

/*
 * The copy table is a literal of strings only, so it can be read out of the source and compared
 * against the keys the component actually reads. This is a static consistency check, not a render:
 * a key that is read but missing, or present in one language only, would otherwise surface as the
 * literal text `undefined` on a user's screen.
 */
const copyStart = source.indexOf('const copy = ')
const copyEnd = source.indexOf('/** Follow the app')
let tables
try {
  const literal = source.slice(copyStart + 'const copy = '.length, copyEnd).trim().replace(/,\s*$/, '')
  tables = new Function(`return (${literal})`)()
} catch (error) {
  check('copy table is parseable', false, String(error))
}

const zhKeys = Object.keys(tables?.zh ?? {}).sort()
const enKeys = Object.keys(tables?.en ?? {}).sort()
check('copy tables were read out of the source', zhKeys.length > 0 && enKeys.length > 0, `${zhKeys.length}/${enKeys.length} keys`)
const sameKeys = JSON.stringify(zhKeys) === JSON.stringify(enKeys)
check(
  'zh and en declare the same keys',
  sameKeys,
  sameKeys
    ? `${zhKeys.length} keys each`
    : `only in zh: ${zhKeys.filter((key) => !enKeys.includes(key)).join(',')} | only in en: ${enKeys
        .filter((key) => !zhKeys.includes(key))
        .join(',')}`,
)

// `t.<key>` inside the component, plus `text().<key>` — the slot label reads its copy that way.
const usedKeys = [
  ...new Set([
    ...[...code.matchAll(/\bt\.([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]),
    ...[...code.matchAll(/text\(\)\.([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]),
  ]),
].sort()
const missingZh = usedKeys.filter((key) => !zhKeys.includes(key))
const missingEn = usedKeys.filter((key) => !enKeys.includes(key))
equal('every t.<key> read in the component exists in zh', missingZh, [])
equal('every t.<key> read in the component exists in en', missingEn, [])
const unused = zhKeys.filter((key) => !usedKeys.includes(key))
equal('no copy key is declared and never read', unused, [])
console.log(`      (${usedKeys.length} copy keys read by the component)`)

console.log(`\n=== ${checks - failures.length}/${checks} checks passed ===`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('visual verification: NOT PERFORMED (no renderer, no browser, no live host)')
}
