// Деплой только токена SEM.
//
// Отдельный скрипт, а не флаг у deploy.mjs, по двум причинам:
//   1. deploy.mjs переразворачивает ВСЕ контракты и перезаписывает
//      deployments.js — тестовый токен затёр бы адреса живой биржи;
//   2. токен разворачивают один раз и отдельно от биржи, это другая операция
//      с другими последствиями.
//
// Адрес токена дописывается в deployments.js как отдельное поле, не трогая
// остальные. Если поле уже есть, скрипт откажется: перезапись потеряла бы
// адрес ранее выпущенного токена.
//
// Использование:
//   node scripts/deploy-token.mjs --dry-run
//   node scripts/deploy-token.mjs --supply 1000000000 --recipient 0x...
//
// Ключ берётся из DEPLOYER_KEY (или из .env).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, formatEther, formatGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { encodeAbiParameters } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

function readEnv(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

function getArg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

const SUPPLY = BigInt(getArg('--supply', '1000000000')) * 10n ** 18n
const RECIPIENT = getArg('--recipient', null)

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const art = artifacts.SementsulToken
if (!art) {
  console.error('ошибка: в артефактах нет SementsulToken — запустите node scripts/compile.mjs')
  process.exit(1)
}

// Проверяем, не выпущен ли токен уже: повторный деплой создал бы второй SEM,
/// и люди не поняли бы, какой из них «настоящий».
const deploymentsPath = join(ROOT, 'src', 'contracts', 'deployments.js')
const deploymentsSrc = readFileSync(deploymentsPath, 'utf8')
const existing = deploymentsSrc.match(/token:\s*'(0x[0-9a-fA-F]{40})'/)

if (existing && !dryRun) {
  console.error(`\nтокен уже развёрнут: ${existing[1]}`)
  console.error('повторный деплой создал бы второй SEM с тем же именем.')
  console.error('если нужен именно новый экземпляр — уберите поле token из')
  console.error('src/contracts/deployments.js вручную и запустите снова.')
  process.exit(1)
}

async function main() {
  const privateKey = process.env.DEPLOYER_KEY ?? readEnv('DEPLOYER_KEY')
  if (!privateKey && !dryRun) {
    console.error('ошибка: не задан DEPLOYER_KEY (или запустите с --dry-run)')
    process.exit(1)
  }

  console.log('=== деплой токена SEM в BNB Chain ===\n')

  const initCode = art.bytecode.length / 2 - 1
  const deployedLen = art.deployedBytecode.length / 2 - 1

  // Аргументы конструктора: (address recipient, uint256 initialSupply)
  const placeholderRecipient = RECIPIENT ?? '0x' + '00'.repeat(20)
  const argsHex = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [placeholderRecipient, SUPPLY]
  ).slice(2)

  const gasEstimate = 21000n + BigInt(deployedLen) * 200n + BigInt(initCode + argsHex.length / 2) * 16n

  console.log(`предложение:   ${SUPPLY / 10n ** 18n} SEM`)
  console.log(`получатель:    ${RECIPIENT ?? 'деплоер'}`)
  console.log(`байткод:       ${initCode} байт создания, ${deployedLen} байт развёрнуто`)
  console.log(`оценка газа:   ${gasEstimate}`)

  if (dryRun) {
    console.log('\n--dry-run: транзакция не отправлена')
    return
  }

  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({ chain: bsc, transport: http(RPC) })
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(RPC) })

  const recipient = RECIPIENT ?? account.address
  const balance = await publicClient.getBalance({ address: account.address })
  const gasPrice = await publicClient.getGasPrice()
  const cost = gasEstimate * gasPrice

  console.log(`\nдеплоер:       ${account.address}`)
  console.log(`баланс:        ${formatEther(balance)} BNB`)
  console.log(`газ:           ${formatGwei(gasPrice)} gwei`)
  console.log(`стоимость:     ${formatEther(cost)} BNB`)

  if (balance < cost) {
    console.error(`\nнедостаточно средств: нужно ${formatEther(cost)} BNB`)
    process.exit(1)
  }

  // Пересобираем calldata с настоящим получателем.
  const finalArgs = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [recipient, SUPPLY]
  ).slice(2)

  console.log('\nотправляем...')
  const hash = await walletClient.sendTransaction({
    account,
    chain: bsc,
    data: art.bytecode + finalArgs,
    gas: gasEstimate + 200_000n,
    gasPrice,
  })
  console.log(`  транзакция: ${hash}`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    console.error('  ОТМЕНЕНА сетью')
    process.exit(1)
  }
  if (!receipt.contractAddress) {
    console.error('  в чеке нет адреса контракта')
    process.exit(1)
  }

  const tokenAddress = receipt.contractAddress
  console.log(`  адрес: ${tokenAddress}`)
  console.log(`  газ: ${receipt.gasUsed}`)

  // Проверяем, что токен действительно отвечает и параметры верные.
  const abi = art.abi
  const [name, symbol, decimals, supply, bal] = await Promise.all([
    publicClient.readContract({ address: tokenAddress, abi, functionName: 'name' }),
    publicClient.readContract({ address: tokenAddress, abi, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenAddress, abi, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenAddress, abi, functionName: 'totalSupply' }),
    publicClient.readContract({ address: tokenAddress, abi, functionName: 'balanceOf', args: [recipient] }),
  ])

  console.log('\nпроверка на цепи:')
  console.log(`  name:        ${name}`)
  console.log(`  symbol:      ${symbol}`)
  console.log(`  decimals:    ${decimals}`)
  console.log(`  totalSupply: ${Number(supply) / 1e18} SEM`)
  console.log(`  баланс получателя: ${Number(bal) / 1e18} SEM`)

  if (name !== 'Sementsul' || symbol !== 'SEM' || decimals !== 18) {
    console.error('\nВНИМАНИЕ: метаданные не совпадают с ожидаемыми')
    process.exit(1)
  }
  if (supply !== SUPPLY || bal !== SUPPLY) {
    console.error('\nВНИМАНИЕ: предложение или баланс не совпадают')
    process.exit(1)
  }

  // Дописываем адрес в deployments.js, не трогая остальные поля.
  //
  // Файл пишется deploy.mjs как JSON (двойные кавычки), поэтому регэксп
  // принимает оба вида кавычек. Первая версия ждала только одинарные и не
  // нашла ни поля token, ни deployer — адрес пришлось вписывать руками.
  const updated = deploymentsSrc.replace(
    /^(\s*)"?token"?\s*:\s*['"][^'"]*['"],?$/m,
    `$1"token": "${tokenAddress}",`
  )

  let next
  if (updated !== deploymentsSrc) {
    next = updated
  } else {
    // Поля token ещё нет — вставляем после deployer.
    next = deploymentsSrc.replace(
      /^(\s*)"?deployer"?\s*:\s*['"](0x[0-9a-fA-F]{40})['"],?$/m,
      (_m, indent, addr) =>
        `${indent}"deployer": "${addr}",\n` +
        `${indent}// Тестовый SEM: выпущен отдельно от биржи, чтобы было чем\n` +
        `${indent}// наполнить пул. У токена нет владельца и нет mint.\n` +
        `${indent}"token": "${tokenAddress}",\n` +
        `${indent}"tokenSymbol": "SEM",\n` +
        `${indent}"tokenName": "Sementsul",\n` +
        `${indent}"tokenDecimals": 18,`
    )
  }

  if (next === deploymentsSrc) {
    console.error('\nне смог обновить deployments.js — адрес токена записан только в консоль')
    console.error(`впишите вручную: token: '${tokenAddress}',`)
    process.exit(1)
  }

  writeFileSync(deploymentsPath, next, 'utf8')
  console.log('\nадрес записан в src/contracts/deployments.js')
  console.log('\nследующий шаг — верификация:')
  console.log(`  node scripts/verify.mjs`)
}

main().catch((e) => {
  console.error('ошибка:', e.message)
  process.exit(1)
})