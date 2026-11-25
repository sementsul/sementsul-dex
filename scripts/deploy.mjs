// Деплой контрактов Sementsul в BNB Chain.
//
// Ключ берётся из переменной окружения DEPLOYER_KEY и нигде не сохраняется.
// Без ключа скрипт работает в режиме --dry-run: показывает, что будет
// отправлено, но не отправляет. Так можно проверить аргументы конструктора
// и оценку газа до того, как тратить реальные BNB.
//
// Подпись делегирована viem: он уже в зависимостях проекта, и его реализация
// EIP-155 проверена тысячами транзакций. Своя подпись здесь была бы лишним
// риском: ошибка в RLP или в v не видна до момента отправки, то есть уже
// после того, как ключ вставлен и BNB потрачены.
//
// Использование:
//   node scripts/deploy.mjs --dry-run        — показать план
//   DEPLOYER_KEY=0x... node scripts/deploy.mjs
//   node scripts/deploy.mjs --fee 50 --v3-tiers 50:1,500:10,2500:50,10000:200
//
// --v3-tiers задаёт пары «комиссия:шаг тика» через запятую. Порядок важен
// только для читаемости вывода, на логику не влияет.
//
// Единица комиссии — 1e-6 (FEE_DENOMINATOR = 1e6): 2500 = 0.25%,
// 500 = 0.05%, 50 = 0.005%. Это не базисные пункты — 0.005% в них не
// выражается целым числом, ради чего и затевалась своя биржа.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

// WBNB — обёртка нативного BNB; роутеру нужна для работы с BNB.
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const getArg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const FEE = BigInt(getArg('--fee', '2500'))
// Тиры V3: четыре ставки и шаг тика для каждой, в том же порядке.
//
// Набор — параметр, а не константа: 0.005% нужен, чтобы ставка была ниже
// минимальной у Pancake, остальные три повторяют привычную сетку. Шаг тика
// привязан к ставке: узкая комиссия требует мелкого шага, иначе минимальная
// ширина диапазона съедает всю точность.
const V3_TIERS = (getArg('--v3-tiers', '50:1,500:10,2500:50,10000:200') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pair) => {
    const [feeStr, spacingStr] = pair.split(':')
    const fee = BigInt((feeStr ?? '').trim())
    const spacing = BigInt((spacingStr ?? '').trim())
    if (fee <= 0n || fee > 10_000n) throw new Error(`тир ${fee} вне диапазона [1, 10000]`)
    if (spacing <= 0n || spacing > 16383n) throw new Error(`шаг ${spacing} вне диапазона`)
    return { fee, spacing }
  })

if (V3_TIERS.length === 0) throw new Error('--v3-tiers пуст: нужно хотя бы один тир')
if (V3_TIERS.length > 4) throw new Error('--v3-tiers: не больше четырёх тиров')

const V3_FEES = V3_TIERS.map((t) => t.fee)
const V3_SPACINGS = V3_TIERS.map((t) => t.spacing)
// Администратор фабрики V3. Управляет только задержкой JIT и штрафом за
// разворот — ни вывода средств, ни изменения комиссии у него нет. По
// умолчанию это деплоер.

// Токен SEM. По умолчанию не деплоится: обычно контракт токена разворачивают
// один раз и отдельно от биржи. Включается флагом --with-token.
const WITH_TOKEN = args.includes('--with-token')
// 1 млрд SEM — столько же, сколько у текущего SML.
const TOKEN_SUPPLY = BigInt(getArg('--token-supply', (1_000_000_000n * 10n ** 18n).toString()))
const TOKEN_RECIPIENT = getArg('--token-recipient', null)

// uint24 и int24 проверяем здесь: неверное значение поймает и контракт, но
// лучше узнать о нём до отправки, чем из отменённой транзакции.
function assertRange(name, value, min, max) {
  if (value < min || value > max) {
    throw new Error(`${name}=${value} вне диапазона [${min}, ${max}]`)
  }
}

// Приводим значение к виду, который примет encodeAbiParameters.
//
// viem строг к типам: для uint24 подавай bigint или number, для адреса —
// строку, для массива — массив. Наши значения приходят из argv как bigint и
// из плана как строки, поэтому приводим явно, а не надеемся на неявное
// преобразование: ошибка здесь стоила бы отправленной впустую транзакции.
function normalizeArg(value, type) {
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2)
    if (!Array.isArray(value)) throw new Error(`${type}: ожидался массив, получено ${typeof value}`)
    return value.map((v) => normalizeArg(v, inner))
  }
  if (type === 'address') return value
  if (type === 'bool') return Boolean(value)
  if (type.startsWith('uint') || type.startsWith('int')) return BigInt(value)
  if (type === 'string' || type === 'bytes') return value
  throw new Error(`тип ${type} не поддержан в деплое`)
}

// Входы конструктора в том виде, который понимает viem 2.
//
// Голая строка типа для ДИНАМИЧЕСКОГО массива в viem 2 не разбирается: он
// падает с «Cannot read properties of undefined (reading 'match')». Объекты
// { name, type } из ABI работают, поэтому передаём их как есть — заодно не
// теряем имена полей в случае ошибки кодирования.
function ctorParams(inputs) {
  return inputs.map((i) => ({ name: i.name ?? '', type: i.type }))
}

async function main() {
  assertRange('fee', FEE, 0n, 10000n)

  console.log('=== Sementsul DEX: деплой в BNB Chain ===')
  console.log(`RPC: ${RPC}`)
  console.log(`комиссия V2: ${FEE} (${Number(FEE) / 10000}%)`)
  console.log('тиры V3:')
  for (const t of V3_TIERS) {
    console.log(`  ${(Number(t.fee) / 10000).toFixed(4)}%  (fee=${t.fee}, шаг тика ${t.spacing})`)
  }

  // Комиссии протокола больше нет: у фабрик нет ни feeTo, ни владельца.
    //
    // Раньше здесь подставлялся адрес получателя «комиссии протокола». Он не
    // использовался ни одним пулом — поле хранилось, но комиссия не взималась.
    // Вместо того чтобы указывать фиктивный адрес, механизм убран целиком:
    // теперь вся комиссия обмена достаётся поставщикам ликвидности, и это
    // видно по коду, а не на слово.
    //
    // У фабрики V3 остаётся admin — он управляет только задержкой JIT и
    // штрафом за разворот. Выводить средства или менять комиссию он не может.
    //
    // Адрес подставляем позже, когда кошелёк деплоера уже создан: раньше здесь
    // стояло account.address, и скрипт падал с «Cannot access 'account' before
    // initialization» — обращение к ещё не объявленной переменной.
    const adminArg = getArg('--admin', null)

    const plan = [
      ['SementsulFactory', [FEE], 'фабрика V2'],
      ['SementsulV3Factory', [V3_FEES, V3_SPACINGS, adminArg ?? '__DEPLOYER__'], 'фабрика V3'],
      ['SementsulRouter', ['__FACTORY__', WBNB], 'роутер V2'],
      // Роутер V3 нужен отдельно: у него другие примитивы обмена (точный
      // вход/выход, мульти-хоп, multicall), и он обслуживает фабрику V3, а не
      // V2. Раньше его не было вовсе, и V3-пулы нельзя было торговать ни через
      // наш интерфейс, ни через внешние интеграции.
      ['SementsulV3Router', ['__V3_FACTORY__', WBNB], 'роутер V3'],
    ]

  // Токен идёт первым: его адрес нужен для создания пула, а сам он ни от чего
  // не зависит.
  if (WITH_TOKEN) {
    const recipient = TOKEN_RECIPIENT ?? '__DEPLOYER__'
    plan.unshift(['SementsulToken', [recipient, TOKEN_SUPPLY], 'токен SEM'])
  }

  if (dryRun) {
    console.log('\n--- --dry-run: транзакции не отправляются ---\n')
    for (const [name, cargs] of plan) {
      const art = artifacts[name]
      const inputs = art.abi.find((x) => x.type === 'constructor')?.inputs ?? []
      // Считаем длину calldata тем же кодировщиком, что и при отправке:
      // плейсхолдеры подменяем на нулевой адрес той же длины. Раньше здесь
      // было ручное «слово на аргумент» — на динамических массивах оно давало
      // неверную длину, то есть dry-run врал о размере транзакции.
      const placeholderArgs = cargs.map((a, i) => {
        const type = inputs[i]?.type ?? ''
        if (type.endsWith('[]')) return a // массив чисел, кодируем как есть
        // Любой плейсхолдер вида __ЧТО_УГОДНО__ — это адрес, которого на
        // момент dry-run ещё нет. Подставляем нули той же длины: важно лишь
        // получить верный размер calldata.
        if (typeof a === 'string' && /^__[A-Z0-9_]+__$/.test(a)) {
          return '0x' + '00'.repeat(20)
        }
        return a
      })
      const encoded =
        inputs.length === 0
          ? ''
          : encodeAbiParameters(
              ctorParams(inputs),
              placeholderArgs.map((a, i) => normalizeArg(a, inputs[i].type))
            ).slice(2)
      const size = (art.bytecode.length - 2) / 2
      console.log(
        `${name.padEnd(18)} байткод ${String(size).padStart(6)} байт, calldata ${encoded.length / 2} байт — ${plan.find((p) => p[0] === name)[2]}`
      )
    }
    if (WITH_TOKEN) {
      console.log(`\nтокен: предложение ${TOKEN_SUPPLY / 10n ** 18n} SEM, получатель ${TOKEN_RECIPIENT ?? 'деплоер'}`)
    }
    console.log('\nпорядок важен: адрес роутера зависит от адреса фабрики,')
    console.log('поэтому роутер деплоится последним и получает реальный адрес.')
    console.log('\nзапустите без --dry-run, задав DEPLOYER_KEY.')
    return
  }

  const privateKey = process.env.DEPLOYER_KEY
  if (!privateKey) throw new Error('не задан DEPLOYER_KEY (или запустите с --dry-run)')

  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({ chain: bsc, transport: http(RPC) })
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(RPC) })

  const balance = await publicClient.getBalance({ address: account.address })
  const gasPrice = await publicClient.getGasPrice()

  console.log(`\nдеплоер: ${account.address}`)
  console.log(`баланс: ${Number(balance) / 1e18} BNB, газ: ${gasPrice} wei`)

  let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  const deployed = {}
  let totalGas = 0n

  for (const [name, cargs, label] of plan) {
    const art = artifacts[name]
    if (!art) throw new Error(`нет артефакта ${name}`)

    // Плейсхолдеры подставляем только теперь, когда адреса известны: фабрика
// нужна роутеру, а получатель токена по умолчанию — сам деплоер.
    const resolved = cargs.map((a) =>
      a === '__FACTORY__'
        ? deployed.factory
        : a === '__V3_FACTORY__'
          ? deployed.v3Factory
          : a === '__DEPLOYER__'
            ? account.address
            : a
    )
    // Кодируем через viem, а не вручную.
    //
    // Прежняя схема «каждое значение — одно 32-байтное слово» верна только для
    // простых типов. У фабрики V3 в конструкторе два ДИНАМИЧЕСКИХ массива:
    // такое кодирование дало бы битую calldata, и деплой отвалился бы уже
    // после списания газа. encodeAbiParameters берёт типы из ABI артефакта,
    // то есть из того же источника, что и байткод.
    const inputs = art.abi.find((x) => x.type === 'constructor')?.inputs ?? []
    const encodedArgs =
      inputs.length === 0
        ? ''
        : encodeAbiParameters(
            ctorParams(inputs),
            resolved.map((a, i) => normalizeArg(a, inputs[i].type))
          ).slice(2)
    // asUintN обязателен: BigInt.toString(16) для отрицательного числа даёт
    // "-a", а не дополнение до 256 бит, и calldata получилась бы битой.
    const hash = await walletClient.sendTransaction({
      account,
      chain: bsc,
      data: art.bytecode + encodedArgs,
      nonce: nonce++,
      gasPrice,
    })
    console.log(`  ${label}: отправлено ${hash}`)

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${name}: транзакция отменена`)
    if (!receipt.contractAddress) throw new Error(`${name}: в чеке нет адреса контракта`)

    // Ключ в результате зависит от контракта: роутер не фабрика, а токен —
    // вообще отдельная сущность. Явное сопоставление читается лучше вложенных
    // тернарников и не даёт молча записать адрес не туда.
    const KEY_BY_NAME = {
      SementsulToken: 'token',
      SementsulFactory: 'factory',
      SementsulV3Factory: 'v3Factory',
      SementsulRouter: 'router',
      SementsulV3Router: 'v3Router',
    }
    const key = KEY_BY_NAME[name]
    if (!key) throw new Error(`${name}: неизвестный контракт, не знаю, куда писать адрес`)
    deployed[key] = receipt.contractAddress
    totalGas += receipt.gasUsed
    console.log(`  ${label}: ${receipt.contractAddress} (газ ${receipt.gasUsed})`)
  }

  const cost = totalGas * gasPrice
  console.log(`\nвсего газа: ${totalGas}, стоимость: ${Number(cost) / 1e18} BNB`)

  const deployments = {
    chainId: 56,
    deployed: true,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    fee: Number(FEE),
    // Список тиров записываем целиком: интерфейс спрашивает у деплоя, какие
    // тиры включены, и без этого поля показывал бы только один пул из четырёх.
    v3FeeTiers: V3_TIERS.map((t) => Number(t.fee)),
    v3TickSpacings: Object.fromEntries(V3_TIERS.map((t) => [Number(t.fee), Number(t.spacing)])),
    // Комиссии протокола нет — вся комиссия обмена идёт поставщикам
    // ликвидности. Поля feeTo в деплое больше нет: его не стало и в
    // контрактах, иначе интерфейс показывал бы механизм, которого нет.
    admin: adminArg ?? account.address,
    factory: deployed.factory,
    v3Factory: deployed.v3Factory,
    router: deployed.router,
    // Роутер V3 — отдельный контракт. Без него V3-пулы нельзя было торговать
    // ни из интерфейса, ни через внешние интеграции: старый роутер знает
    // только V2.
    v3Router: deployed.v3Router,
    // Поля токена появляются, только если он развёрнут этим запуском: иначе
    // они затёрли бы адрес ранее выпущенного токена нулями.
    ...(deployed.token
      ? {
          token: deployed.token,
          tokenSymbol: 'SEM',
          tokenName: 'Sementsul',
          tokenDecimals: 18,
          tokenSupply: TOKEN_SUPPLY.toString(),
          tokenRecipient: TOKEN_RECIPIENT ?? account.address,
        }
      : {}),
    wbnb: WBNB,
  }

  // Пишем JS-модуль, а не JSON: JSON в Node требует import-атрибута
  // (`with { type: 'json' }`), которого Vite не поддерживает. Модуль читается
  // и сборкой, и скриптами проверки без дополнительных настроек.
  const moduleSrc = `// Адреса задеплоенных контрактов Sementsul.
//
// Файл создан автоматически скриптом scripts/deploy.mjs ${deployments.deployedAt}.
// Не редактировать вручную: при повторном деплое он будет перезаписан.

export default ${JSON.stringify(deployments, null, 2)}
`
  writeFileSync(join(ROOT, 'src', 'contracts', 'deployments.js'), moduleSrc)
  console.log('\nадреса записаны: src/contracts/deployments.js')
  console.log(JSON.stringify(deployments, null, 2))
}

main().catch((e) => {
  console.error('ошибка:', e.shortMessage ?? e.message)
  process.exit(1)
})