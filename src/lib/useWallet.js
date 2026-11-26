// Хук кошелька — единственный источник правды о подключении.
// Раньше состояние дублировалось в App и SwapCard, из-за чего «Отключить»
// в шапке не доходило до карточки.

import { useCallback, useEffect, useState } from 'react'
import {
  hasWallet,
  connect,
  reconnect,
  disconnect,
  onAccountsChanged,
  onChainChanged,
  switchToBsc,
} from '../lib/wallet.js'
import { CHAIN_ID } from '../lib/chain.js'

export function useWallet() {
  const [account, setAccount] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [available, setAvailable] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setAvailable(hasWallet())
    let alive = true

    reconnect().then((res) => {
      if (!alive || !res) return
      setAccount(res.address)
      setChainId(res.chainId)
    })

    const offAcc = onAccountsChanged((addr) => {
      setAccount(addr)
      if (!addr) disconnect()
    })
    const offChain = onChainChanged(setChainId)

    return () => {
      alive = false
      offAcc()
      offChain()
    }
  }, [])

  const connectWallet = useCallback(async () => {
    setError(null)
    try {
      const res = await connect()
      setAccount(res.address)
      setChainId(res.chainId)
      if (res.chainId !== CHAIN_ID) {
        await switchToBsc().catch(() => {})
      }
      return res
    } catch (e) {
      setError(e?.message ?? 'Не удалось подключить кошелёк')
      throw e
    }
  }, [])

  const disconnectWallet = useCallback(() => {
    disconnect()
    setAccount(null)
    setChainId(null)
  }, [])

  return {
    account,
    chainId,
    available,
    error,
    connect: connectWallet,
    disconnect: disconnectWallet,
    wrongChain: account !== null && chainId !== null && chainId !== CHAIN_ID,
  }
}