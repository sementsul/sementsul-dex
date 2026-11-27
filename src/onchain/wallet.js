// Кошелёк: подключение, смена сети, отправка транзакций.
// Работает с любым EIP-1193 провайдером (MetaMask, Trust, OKX) без SDK.

import { CHAIN_ID } from './config.js'

export function getProvider() {
  const eth = window.ethereum
  if (!eth) return null
  // Если установлено несколько кошельков, они выставляют себя в providers.
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find((p) => p.isMetaMask) ?? eth.providers[0]
  }
  return eth
}

export async function connect() {
  const p = getProvider()
  if (!p) throw new Error('NO_WALLET')
  const accounts = await p.request({ method: 'eth_requestAccounts' })
  if (!accounts?.length) throw new Error('NO_ACCOUNT')
  await ensureChain(p)
  return accounts[0]
}

export async function ensureChain(p) {
  const hex = '0x' + CHAIN_ID.toString(16)
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (e) {
    // 4902 — сети нет в кошельке. Добавляем.
    if (e?.code === 4902 || String(e?.message ?? '').includes('Unrecognized chain')) {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hex,
            chainName: 'BNB Smart Chain',
            nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
            rpcUrls: ['https://bsc-dataseed.binance.org'],
            blockExplorerUrls: ['https://bscscan.com'],
          },
        ],
      })
    } else {
      throw e
    }
  }
}

export async function currentChainId(p) {
  const id = await p.request({ method: 'eth_chainId' })
  return parseInt(id, 16)
}

export async function sendTx(p, from, tx) {
  const params = {
    from,
    to: tx.to,
    data: tx.data,
    value: tx.value && tx.value > 0n ? '0x' + tx.value.toString(16) : '0x0',
  }
  return p.request({ method: 'eth_sendTransaction', params: [params] })
}

export function onAccountsChanged(cb) {
  const p = getProvider()
  if (!p?.on) return () => {}
  const h = (accs) => cb(accs?.[0] ?? null)
  p.on('accountsChanged', h)
  return () => p.removeListener?.('accountsChanged', h)
}

export function onChainChanged(cb) {
  const p = getProvider()
  if (!p?.on) return () => {}
  const h = (id) => cb(parseInt(id, 16))
  p.on('chainChanged', h)
  return () => p.removeListener?.('chainChanged', h)
}