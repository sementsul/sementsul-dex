// Хук кошелька — единственный источник правды о подключении.
// Раньше состояние дублировалось в App и SwapCard, из-за чего «Отключить»
// в шапке не доходило до карточки.
//
// Здесь же живёт комплаенс-гейт: проверка геолокации и санкционного списка.
// Он регистрируется в wallet.js, поэтому блокирует ЛЮБУЮ транзакцию, а не
// только ту, до которой добрался обработчик кнопки.

import { useCallback, useEffect, useState } from 'react'
import {
  hasWallet,
  connect,
  reconnect,
  disconnect,
  onAccountsChanged,
  onChainChanged,
  switchToBsc,
  setComplianceGate,
} from '../lib/wallet.js'
import { CHAIN_ID } from '../lib/chain.js'
import { useCompliance } from './useCompliance.js'

export function useWallet() {
  const [account, setAccount] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [available, setAvailable] = useState(false)
  const [error, setError] = useState(null)

  const compliance = useCompliance(account)

  // Регистрируем гейт в модуле кошелька. Эффект зависит от assertAllowed,
  // поэтому при смене адреса или загрузке списка гейт обновляется сам.
  useEffect(() => {
    setComplianceGate(compliance.assertAllowed)
    // Размонтирование приложения снимает гейт, чтобы тесты и отдельные
    // страницы не наследовали чужое состояние.
    return () => setComplianceGate(null)
  }, [compliance.assertAllowed])

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
    // Комплаенс прокидываем наружу, чтобы карточки показывали причину отказа
    // и прятали кнопки записи.
    compliance,
  }
}