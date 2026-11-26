// Кошелёк: прямой EIP-1193, без ethers/ wagmi. Поддерживаем MetaMask, Trust,
// Rabby, OKX и всё, что инжектит window.ethereum.
//
// Отправка транзакций идёт через кошелёк, но подпись и nonce он берёт из своей
// ноды. Чтобы MEV-защита работала, кошелёк должен быть переключён на
// bscrpc.pancakeswap.finance — это отдельный шаг в настройках, см. ensureChain().

import { CHAIN_ID, RPC_PRIVATE } from './chain.js'
import { rpc } from './rpc.js'

const STORAGE_KEY = 'sml-dex:wallet-connected'

export function getInjected() {
  if (typeof window === 'undefined') return null
  const eth = window.ethereum
  if (!eth) return null
  // Если кошельков несколько, window.ethereum — это их агрегатор (EIP-6963).
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find((p) => p.isMetaMask) ?? eth.providers[0]
  }
  return eth
}

export function hasWallet() {
  return getInjected() !== null
}

// Список установленных кошельков через EIP-6963 — точнее, чем window.ethereum.
export function discoverWallets(timeoutMs = 300) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve([])
    const found = []
    const onAnnounce = (event) => {
      const { info, provider } = event.detail ?? {}
      if (info && provider && !found.some((w) => w.info.uuid === info.uuid)) {
        found.push({ info, provider })
      }
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      resolve(found)
    }, timeoutMs)
  })
}

export async function connect() {
  const eth = getInjected()
  if (!eth) throw new Error('Кошелёк не найден. Установите MetaMask или Trust Wallet.')

  const accounts = await eth.request({ method: 'eth_requestAccounts' })
  if (!accounts?.length) throw new Error('Кошелёк не вернул адрес')

  const chainIdHex = await eth.request({ method: 'eth_chainId' })
  const chainId = Number(BigInt(chainIdHex))

  localStorage.setItem(STORAGE_KEY, '1')
  return { address: accounts[0], chainId }
}

// Тихое переподключение при загрузке страницы — без всплывающего окна.
export async function reconnect() {
  const eth = getInjected()
  if (!eth || localStorage.getItem(STORAGE_KEY) !== '1') return null
  try {
    const accounts = await eth.request({ method: 'eth_accounts' })
    if (!accounts?.length) return null
    const chainIdHex = await eth.request({ method: 'eth_chainId' })
    return { address: accounts[0], chainId: Number(BigInt(chainIdHex)) }
  } catch {
    return null
  }
}

export function disconnect() {
  localStorage.removeItem(STORAGE_KEY)
}

export async function switchToBsc() {
  const eth = getInjected()
  if (!eth) throw new Error('Кошелёк не найден')
  const chainIdHex = '0x' + CHAIN_ID.toString(16)
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
  } catch (e) {
    // 4902 = сеть не добавлена в кошелёк
    if (e.code === 4902 || e?.data?.originalError?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainIdHex,
            chainName: 'BNB Smart Chain',
            nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
            rpcUrls: [RPC_PRIVATE],
            blockExplorerUrls: ['https://bscscan.com'],
          },
        ],
      })
    } else {
      throw e
    }
  }
}

export function onAccountsChanged(cb) {
  const eth = getInjected()
  if (!eth?.on) return () => {}
  const handler = (accounts) => cb(accounts?.[0] ?? null)
  eth.on('accountsChanged', handler)
  return () => eth.removeListener?.('accountsChanged', handler)
}

export function onChainChanged(cb) {
  const eth = getInjected()
  if (!eth?.on) return () => {}
  const handler = (chainIdHex) => cb(Number(BigInt(chainIdHex)))
  eth.on('chainChanged', handler)
  return () => eth.removeListener?.('chainChanged', handler)
}

// ---------- операции ----------

// Потолок газа одной транзакции.
//
// bscrpc.pancakeswap.finance (Pancake MEV Guard) отклоняет транзакции с gas
// выше 16777216 (2^24) с ошибкой «transaction gas limit too high». Публичные
// ноды терпимее, но кошелёк может быть переключён на MEV-guard, и тогда
// сделка не уйдёт вовсе. Поэтому ограничение ставим на своей стороне, а не
// надеемся на ноду.
export const MAX_GAS = 16_777_216n

// Запасной лимит, когда оценка газа не удалась.
//
// Раньше в этом случае gas не задавался вовсе, и решение отдавалось кошельку.
// MetaMask без оценки берёт лимит блока (80 млн на BSC) и умножает на 0.35 —
// получается ровно 28 000 000, что выше потолка MEV-guard RPC. Отсюда ошибка
// «gas limit too high (cap: 16777216, tx: 28000000)», которую видел
// пользователь. Теперь при неудачной оценке подставляем своё значение.
//
// 3 млн — с большим запасом: обмен на нашем пуле занимает ~150 тыс., создание
// позиции V3 — до ~1 млн. Если операция потребует больше, транзакция
// упрётся в out-of-gas, и это понятная ошибка, а не отказ RPC.
export const FALLBACK_GAS = 3_000_000n

// ---------- комплаенс-шлюз ----------
//
// Все транзакции в приложении идут через sendTransaction, поэтому проверка
// здесь — единственная точка, которую нельзя обойти, вызвав обработчик
// кнопки напрямую из консоли браузера. Компоненты выставляют этот гейт через
// setComplianceGate из useCompliance.
//
// Гейт — функция без аргументов, которая бросает Error с объяснением, если
// операция запрещена. null означает «проверок нет» (локальная разработка без
// API или до инициализации приложения).
let complianceGate = null

export function setComplianceGate(fn) {
  complianceGate = typeof fn === 'function' ? fn : null
}

export function getComplianceGate() {
  return complianceGate
}

// Отправить транзакцию через кошелёк. Возвращает хеш.
export async function sendTransaction({ to, data, value = 0n, gasLimit }) {
  // Проверка ДО любых сетевых вызовов: если операция запрещена, не нужно ни
  // оценивать газ, ни тревожить кошелёк.
  if (complianceGate) complianceGate()

  const eth = getInjected()
  if (!eth) throw new Error('Кошелёк не найден')

  const from = (await eth.request({ method: 'eth_accounts' }))?.[0]
  if (!from) throw new Error('Кошелёк не подключён')

  const tx = {
    from,
    to,
    data,
    value: '0x' + value.toString(16),
  }

  // Газ задаётся ВСЕГДА, ни один путь не оставляет его кошельку.
  let gas
  if (gasLimit) {
    gas = BigInt(gasLimit)
  } else {
    try {
      const est = await rpc('eth_estimateGas', [{ from, to, data, value: tx.value }])
      // Запас 20%: на Pancake V3 оценка бывает оптимистичной.
      gas = (BigInt(est) * 12n) / 10n
    } catch {
      gas = FALLBACK_GAS
    }
  }

  // Оценка выше потолка RPC — почти наверняка ошибка ноды, а не реальная
  // потребность: обмен на BSC не требует 16 млн газа. Обрезаем, иначе
  // транзакция будет отклонена ещё до отправки.
  if (gas > MAX_GAS) gas = MAX_GAS

  tx.gas = '0x' + gas.toString(16)

  return eth.request({ method: 'eth_sendTransaction', params: [tx] })
}

export async function waitForReceipt(hash, timeoutMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await rpc('eth_getTransactionReceipt', [hash])
      if (receipt) return receipt
    } catch {
      // нода ещё не знает о транзакции
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('Транзакция не подтвердилась за 2 минуты')
}

export async function getNativeBalance(address) {
  const hex = await rpc('eth_getBalance', [address, 'latest'])
  return BigInt(hex)
}