// Вывод WBNB с кошелька бота на адрес получателя.
//
// Зачем отдельный скрипт: кнопка «вывести» в боте WBNB не трогает вообще.
// В его коде (sweepTo) есть только две ветки — transfer USDT и отправка BNB.
// Баланс WBNB читается, но никуда не используется. Поэтому WBNB, который
// вернулся из закрытой NFT-позиции, застревает на кошельке навсегда, и
// достать его можно только вручную — этим скриптом.
//
// ИМЯ СЕКРЕТА
// -----------
// Ключ берётся из переменной окружения BOT_PRIVATE_KEY (см. SECRET_NAME ниже).
// Ключ никогда не печатается и не пишется в файл: скрипт читает его из
// окружения, подписывает локально и наружу отдаёт только готовую транзакцию.
//
// Если переменная не задана, скрипт ничего не делает и объясняет, как задать.
// Значение Cloudflare не отдаёт (секреты там только на запись), поэтому
// подставить его автоматически нельзя — только руками в этом сеансе.
//
// ЗАЩИТА ОТ ОШИБКИ АДРЕСА
// -----------------------
// Перед отправкой скрипт сверяет адрес, которому принадлежит ключ, с
// EXPECTED_OWNER. Если ключ от другого кошелька — отказ. Это важно: WBNB
// необратимо уйдёт на тот адрес, который указан в --to, и перепутать
// кошелёк здесь стоит всех денег.
//
// Использование:
//   node scripts/sweep-wbnb.mjs --dry-run
//   node scripts/sweep-wbnb.mjs
//
// Переменные:
//   BOT_PRIVATE_KEY  ключ кошелька, с которого выводим (обязательно)
//   BSC_RPC          RPC для чтения (необязательно)

import { createPublicClient, createWalletClient, http, formatUnits, formatEther, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

// Имя секрета. Именно эту переменную окружения читает скрипт.
const SECRET_NAME = 'BOT_PRIVATE_KEY'

// Кошелёк бота: на нём лежит WBNB и NFT-позиции Pancake.
const EXPECTED_OWNER = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'

// Куда выводим. Тот же адрес, что стоит в WITHDRAW_TO бота.
const TO = '0xE69a0bcE418F198Fd869d7Ade2175A06fA215BFE'

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

// Приватный RPC: транзакция идёт сразу валидаторам, минуя публичный мемпул,
// поэтому её не видно сэндвич-ботам.
const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const dryRun = process.argv.includes('--dry-run')

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

async function main() {
  // ---------- ключ ----------
  const raw = process.env[SECRET_NAME]

  if (!raw) {
    console.log('=== вывод WBNB ===\n')
    console.log(`секрет ${SECRET_NAME} не задан в окружении — выводить нечем.`)
    console.log('')
    console.log('Задайте его в этом сеансе и повторите:')
    console.log('')
    console.log(`    $env:${SECRET_NAME}="0x..."`)
    console.log('    node scripts/sweep-wbnb.mjs')
    console.log('')
    console.log('Ключ принадлежит кошельку: ' + EXPECTED_OWNER)
    console.log('Cloudflare секреты не отдаёт, поэтому подставить автоматически нельзя.')
    process.exit(1)
  }

  const key = raw.startsWith('0x') ? raw : '0x' + raw
  const account = privateKeyToAccount(key)

  console.log('=== вывод WBNB ===\n')
  console.log('кошелёк:', account.address)
  console.log('получатель:', TO)
  console.log('RPC отправки:', RPC_SEND, '(MEV-guard)')

  // ---------- сверка кошелька ----------
  // Самая дорогая ошибка здесь — подписать чужим ключом. Проверяем до всего
  // остального: иначе скрипт отработает «успешно» с нулевым балансом и
  // создаст ложное впечатление, что денег нет.
  if (account.address.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    console.error('')
    console.error('ОТКАЗ: ключ принадлежит', account.address)
    console.error('а ожидался кошелёк бота', EXPECTED_OWNER)
    console.error('Выводить с чужого кошелька нельзя — проверьте, тот ли ключ задан.')
    process.exit(1)
  }

  // ---------- баланс ----------
  const [balance, decimals, symbol, bnb] = await Promise.all([
    read.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    read.readContract({ address: WBNB, abi: erc20, functionName: 'decimals' }),
    read.readContract({ address: WBNB, abi: erc20, functionName: 'symbol' }),
    read.getBalance({ address: account.address }),
  ])

  console.log('')
  console.log(`${symbol}: ${formatUnits(balance, Number(decimals))}`)
  console.log('BNB (на газ):', formatEther(bnb))

  if (balance === 0n) {
    console.log('\nWBNB нет — выводить нечего')
    return
  }

  // На transfer ERC-20 уходит ~51k газа. Если BNB меньше, транзакция
  // отклонится на этапе отправки, и лучше сказать об этом сразу.
  const gasPrice = await read.getGasPrice()
  const gasNeeded = 100_000n * gasPrice
  console.log('нужно на газ:', formatEther(gasNeeded), 'BNB')
  if (bnb < gasNeeded) {
    console.error('\nнедостаточно BNB на газ — пополните кошелёк')
    process.exit(1)
  }

  if (dryRun) {
    console.log(`\n--dry-run: отправили бы ${formatUnits(balance, Number(decimals))} ${symbol} на ${TO}`)
    return
  }

  // ---------- отправка ----------
  const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_SEND) })

  console.log(`\nотправляем ${formatUnits(balance, Number(decimals))} ${symbol}...`)
  const hash = await wallet.writeContract({
    account,
    chain: bsc,
    address: WBNB,
    abi: erc20,
    functionName: 'transfer',
    args: [TO, balance],
    gas: 100_000n,
    gasPrice,
  })
  console.log('транзакция:', hash)

  const receipt = await read.waitForTransactionReceipt({ hash })
  console.log('статус:', receipt.status, '| газ:', receipt.gasUsed)

  // ---------- проверка ----------
  // Не верим статусу на слово: читаем балансы после и убеждаемся, что
  // WBNB действительно ушёл и пришёл именно туда.
  const [left, received] = await Promise.all([
    read.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    read.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [TO] }),
  ])

  console.log('')
  console.log('на кошельке бота осталось:', formatUnits(left, Number(decimals)))
  console.log('на получателе теперь:      ', formatUnits(received, Number(decimals)))

  if (receipt.status !== 'success') {
    console.error('\nТРАНЗАКЦИЯ НЕ ПРОШЛА')
    process.exit(1)
  }
  if (received < balance) {
    console.error('\nВНИМАНИЕ: на получателе меньше, чем отправляли — проверьте вручную')
    process.exit(1)
  }
  console.log('\nготово: WBNB выведен на', TO)
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})