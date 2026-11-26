// Вывод WBNB с кошелька бота: развернуть в обычный BNB и отправить.
//
// Зачем отдельный скрипт: кнопка «вывести» в боте WBNB не трогает вообще.
// В его коде (sweepTo) есть только две ветки — transfer USDT и отправка BNB.
// Баланс WBNB читается, но никуда не используется. Поэтому WBNB, вернувшийся
// из закрытой NFT-позиции, застревает на кошельке навсегда.
//
// ЧТО ЗНАЧИТ «КОНВЕРТИРОВАТЬ»
// ---------------------------
// WBNB — это обёрнутый BNB (1:1). Разворачивается вызовом withdraw() на самом
// контракте WBNB: он сжигает WBNB и возвращает нативный BNB тому же адресу.
// Никакого обмена и никакой комиссии, кроме газа: курс всегда ровно 1:1.
//
// Поэтому порядок такой:
//   1. WBNB.withdraw(весь баланс) — нативный BNB появляется на кошельке;
//   2. обычный перевод BNB на адрес получателя.
//
// Отправлять сам WBNB смысла нет: получателю пришлось бы разворачивать его
// самостоятельно, а для этого нужен газ на чужом кошельке.
//
// ИМЯ СЕКРЕТА
// -----------
// Ключ берётся из переменной окружения BOT_PRIVATE_KEY (константа SECRET_NAME).
// Ключ не печатается и не пишется в файл: подпись локальная, наружу уходит
// только готовая транзакция.
//
// ЗАЩИТА ОТ ОШИБКИ АДРЕСА
// -----------------------
// Перед отправкой скрипт сверяет адрес, которому принадлежит ключ, с
// EXPECTED_OWNER. Ключ от другого кошелька — отказ. Без этой проверки скрипт
// с чужим ключом отработал бы «успешно» с нулевым балансом, и выглядело бы
// так, будто денег нет, хотя они лежат на нужном кошельке.
//
// Использование:
//   node scripts/sweep-wbnb.mjs --dry-run
//   node scripts/sweep-wbnb.mjs
//   node scripts/sweep-wbnb.mjs --to 0x...        (другой получатель)
//   node scripts/sweep-wbnb.mjs --keep-wrapped    (отправить WBNB, не разворачивая)

import { createPublicClient, createWalletClient, http, formatUnits, formatEther, parseAbi, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

// Имя секрета. Именно эту переменную окружения читает скрипт.
const SECRET_NAME = 'BOT_PRIVATE_KEY'

// Кошелёк бота: на нём лежит WBNB и NFT-позиции Pancake.
const EXPECTED_OWNER = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'

// Куда выводим. Тот же адрес, что стоит в WITHDRAW_TO бота, — тот, куда
// пользователь уже выводил USDT.
const DEFAULT_TO = '0xE69a0bcE418F198Fd869d7Ade2175A06fA215BFE'

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

// Приватный RPC: транзакция идёт сразу валидаторам, минуя публичный мемпул.
const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

// Сколько BNB оставить на кошельке: две транзакции (развернуть + перевести)
// при 50 gwei стоят около 0.0000025 BNB. Берём с большим запасом, чтобы
// перевод не сорвался из-за нехватки газа.
const RESERVE = parseEther('0.00003')

const dryRun = process.argv.includes('--dry-run')
const keepWrapped = process.argv.includes('--keep-wrapped')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

const TO = arg('--to', DEFAULT_TO)

const wbnbAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function withdraw(uint256 wad)',
])

const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

async function main() {
  // ---------- ключ ----------
  const raw = process.env[SECRET_NAME]

  if (!raw) {
    console.log('=== вывод WBNB ===\n')
    console.log(`секрет ${SECRET_NAME} не задан в окружении — подписывать нечем.`)
    console.log('')
    console.log('Задайте его в этом сеансе и повторите:')
    console.log('')
    console.log(`    $env:${SECRET_NAME}="0x..."`)
    console.log('    node scripts/sweep-wbnb.mjs --dry-run')
    console.log('    node scripts/sweep-wbnb.mjs')
    console.log('')
    console.log('Ключ принадлежит кошельку: ' + EXPECTED_OWNER)
    console.log('Cloudflare секреты не отдаёт, поэтому подставить автоматически нельзя.')
    process.exit(1)
  }

  const key = raw.startsWith('0x') ? raw : '0x' + raw
  const account = privateKeyToAccount(key)

  console.log('=== вывод WBNB ===\n')
  console.log('кошелёк:  ', account.address)
  console.log('получатель:', TO)
  console.log('режим:     ', keepWrapped ? 'отправить WBNB как есть' : 'развернуть в BNB и отправить')
  console.log('RPC отправки:', RPC_SEND, '(MEV-guard)')

  // ---------- сверка кошелька ----------
  if (account.address.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    console.error('')
    console.error('ОТКАЗ: ключ принадлежит', account.address)
    console.error('а ожидался кошелёк бота', EXPECTED_OWNER)
    console.error('Выводить с чужого кошелька нельзя — проверьте, тот ли ключ задан.')
    process.exit(1)
  }

  // ---------- балансы до ----------
  const [wbnb, decimals, symbol, bnbBefore, gasPrice] = await Promise.all([
    read.readContract({ address: WBNB, abi: wbnbAbi, functionName: 'balanceOf', args: [account.address] }),
    read.readContract({ address: WBNB, abi: wbnbAbi, functionName: 'decimals' }),
    read.readContract({ address: WBNB, abi: wbnbAbi, functionName: 'symbol' }),
    read.getBalance({ address: account.address }),
    read.getGasPrice(),
  ])

  console.log('')
  console.log(`${symbol}: ${formatUnits(wbnb, Number(decimals))}`)
  console.log('BNB:  ', formatEther(bnbBefore), '| газ:', Number(gasPrice) / 1e9, 'gwei')

  if (wbnb === 0n) {
    console.log('\nWBNB нет — выводить нечего')
    return
  }

  // Две транзакции: развернуть (~28k газа) и перевести (~21k). Если BNB
  // впритык, лучше сказать сразу, чем упасть посреди операции с уже
  // развёрнутым WBNB.
  const gasNeeded = 120_000n * gasPrice
  console.log('нужно на газ:', formatEther(gasNeeded), 'BNB')
  if (bnbBefore < gasNeeded) {
    console.error('\nнедостаточно BNB на газ — пополните кошелёк')
    process.exit(1)
  }

  if (dryRun) {
    console.log('')
    if (keepWrapped) {
      console.log(`--dry-run: отправили бы ${formatUnits(wbnb, Number(decimals))} ${symbol} на ${TO}`)
    } else {
      const total = bnbBefore + wbnb
      const sendable = total > RESERVE ? total - RESERVE : 0n
      console.log(`--dry-run: развернули бы ${formatUnits(wbnb, Number(decimals))} ${symbol} в BNB`)
      console.log(`           и отправили ${formatEther(sendable)} BNB на ${TO}`)
      console.log(`           на газ осталось бы ${formatEther(RESERVE)} BNB`)
    }
    return
  }

  const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_SEND) })

  // ---------- отправка ----------
  if (keepWrapped) {
    console.log(`\nотправляем ${formatUnits(wbnb, Number(decimals))} ${symbol}...`)
    const hash = await wallet.writeContract({
      account,
      chain: bsc,
      address: WBNB,
      abi: wbnbAbi,
      functionName: 'transfer',
      args: [TO, wbnb],
      gas: 100_000n,
      gasPrice,
    })
    console.log('транзакция:', hash)
    const receipt = await read.waitForTransactionReceipt({ hash })
    console.log('статус:', receipt.status, '| газ:', receipt.gasUsed)
    if (receipt.status !== 'success') {
      console.error('\nТРАНЗАКЦИЯ НЕ ПРОШЛА')
      process.exit(1)
    }
    const received = await read.readContract({
      address: WBNB,
      abi: wbnbAbi,
      functionName: 'balanceOf',
      args: [TO],
    })
    console.log('\nна получателе WBNB:', formatUnits(received, Number(decimals)))
    console.log('готово')
    return
  }

  // Шаг 1: развернуть. Контракт WBNB сжигает WBNB и отдаёт нативный BNB
  // тому же адресу — обмен строго 1:1, комиссии нет.
  console.log(`\n[1/2] разворачиваем ${formatUnits(wbnb, Number(decimals))} ${symbol} в BNB...`)
  const hashUnwrap = await wallet.writeContract({
    account,
    chain: bsc,
    address: WBNB,
    abi: wbnbAbi,
    functionName: 'withdraw',
    args: [wbnb],
    gas: 60_000n,
    gasPrice,
  })
  console.log('  транзакция:', hashUnwrap)

  const rcUnwrap = await read.waitForTransactionReceipt({ hash: hashUnwrap })
  console.log('  статус:', rcUnwrap.status, '| газ:', rcUnwrap.gasUsed)
  if (rcUnwrap.status !== 'success') {
    console.error('  развернуть не удалось — WBNB остался на месте, деньги никуда не ушли')
    process.exit(1)
  }

  // Проверяем, что BNB действительно появился: контракт мог ответить успехом,
  // но сумма должна сойтись с тем, что мы разворачивали.
  const bnbAfterUnwrap = await read.getBalance({ address: account.address })
  const gained = bnbAfterUnwrap - bnbBefore + rcUnwrap.gasUsed * gasPrice
  console.log('  BNB на кошельке:', formatEther(bnbAfterUnwrap))
  console.log('  прибавилось:', formatEther(gained))
  if (gained < wbnb) {
    console.error('\nВНИМАНИЕ: прибавилось меньше, чем разворачивали — остановка до перевода')
    process.exit(1)
  }

  // Шаг 2: перевести нативный BNB, оставив запас на газ.
  const sendable = bnbAfterUnwrap > RESERVE ? bnbAfterUnwrap - RESERVE : 0n
  if (sendable === 0n) {
    console.log('\nпосле разворачивания нечего отправлять (всё ушло бы на газ)')
    return
  }

  console.log(`\n[2/2] отправляем ${formatEther(sendable)} BNB на ${TO}...`)
  const hashSend = await wallet.sendTransaction({
    account,
    chain: bsc,
    to: TO,
    value: sendable,
    gas: 21_000n,
    gasPrice,
  })
  console.log('  транзакция:', hashSend)

  const rcSend = await read.waitForTransactionReceipt({ hash: hashSend })
  console.log('  статус:', rcSend.status, '| газ:', rcSend.gasUsed)

  // ---------- проверка ----------
  const [leftBnb, leftWbnb, gotBnb] = await Promise.all([
    read.getBalance({ address: account.address }),
    read.readContract({ address: WBNB, abi: wbnbAbi, functionName: 'balanceOf', args: [account.address] }),
    read.getBalance({ address: TO }),
  ])

  console.log('')
  console.log('=== после вывода ===')
  console.log('на кошельке бота: BNB', formatEther(leftBnb), '| WBNB', formatUnits(leftWbnb, 18))
  console.log('на получателе:    BNB', formatEther(gotBnb))

  if (rcSend.status !== 'success') {
    console.error('\nПЕРЕВОД НЕ ПРОШЁЛ')
    process.exit(1)
  }
  if (leftWbnb !== 0n) {
    console.error('\nВНИМАНИЕ: WBNB остался на кошельке — проверьте вручную')
    process.exit(1)
  }
  console.log('\nготово: WBNB развёрнут в BNB и отправлен на', TO)
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})