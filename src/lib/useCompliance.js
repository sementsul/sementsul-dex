// Хук комплаенса: геолокация при загрузке + проверка адреса при подключении.
//
// Единственный источник правды о том, можно ли пользователю совершать
// операции. Компоненты не вычисляют это сами, иначе правила разъедутся.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  evaluateGeo,
  checkAddress,
  describeAddressBlock,
  loadSanctions,
} from '../lib/compliance.js'

/// Опрашивает /api/geo. В локальной разработке без wrangler страница отдаётся
/// Vite, эндпоинта нет — тогда geo остаётся null и проверка не блокирует.
async function fetchGeo() {
  try {
    const res = await fetch('/api/geo', { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    // Защита от SPA-фолбэка: при отсутствии функции Pages отдаст index.html
    // со статусом 200, и json() упадёт — это нормально, ловим.
    if (!data || typeof data !== 'object' || !('country' in data)) return null
    return data
  } catch {
    return null
  }
}

export function useCompliance(account) {
  const [geo, setGeo] = useState(null)
  const [geoLoaded, setGeoLoaded] = useState(false)
  const [addressCheck, setAddressCheck] = useState({
    status: 'idle', // idle | checking | ok | listed | error
    entry: null,
    unavailable: false,
  })

  // ---------- геолокация ----------
  useEffect(() => {
    let alive = true
    fetchGeo().then((g) => {
      if (!alive) return
      setGeo(g)
      setGeoLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // ---------- список санкций ----------
  // Грузим заранее, параллельно с гео: к моменту подключения кошелька он уже
  // в памяти, и проверка не тормозит интерфейс.
  useEffect(() => {
    loadSanctions()
  }, [])

  // ---------- проверка адреса ----------
  useEffect(() => {
    if (!account) {
      setAddressCheck({ status: 'idle', entry: null, unavailable: false })
      return undefined
    }

    let alive = true
    setAddressCheck({ status: 'checking', entry: null, unavailable: false })

    checkAddress(account).then((res) => {
      if (!alive) return
      if (res.unavailable) {
        // Список не загрузился. Не выдаём это за «проверено и чисто»:
        // статус error, интерфейс покажет отдельную пометку.
        setAddressCheck({ status: 'error', entry: null, unavailable: true })
      } else if (res.listed) {
        setAddressCheck({ status: 'listed', entry: res.entry, unavailable: false })
      } else {
        setAddressCheck({ status: 'ok', entry: null, unavailable: false })
      }
    })

    return () => {
      alive = false
    }
  }, [account])

  const geoDecision = useMemo(() => evaluateGeo(geo), [geo])

  const addressBlocked = addressCheck.status === 'listed'
  const addressMessage = addressBlocked ? describeAddressBlock(addressCheck.entry) : null

  // Итог: можно ли писать в блокчейн.
  //
  // Проверка адреса в статусе 'checking' НЕ блокирует: иначе кнопка мигала бы
  // при каждом подключении. Блокировка наступает, только когда список точно
  // подтвердил совпадение.
  const blocked = geoDecision.blocked || addressBlocked

  const reason = useMemo(() => {
    if (geoDecision.blocked) return geoDecision.message
    if (addressBlocked) return addressMessage
    return null
  }, [geoDecision, addressBlocked, addressMessage])

  /// Бросает ошибку, если операция запрещена. Вызывается из sendTransaction
  /// и из обработчиков кнопок — чтобы блокировку нельзя было обойти, вызвав
  /// функцию напрямую из консоли.
  const assertAllowed = useCallback(() => {
    if (geoDecision.blocked) {
      throw new Error(geoDecision.message)
    }
    if (addressBlocked) {
      throw new Error(addressMessage)
    }
  }, [geoDecision, addressBlocked, addressMessage])

  return {
    geo,
    geoLoaded,
    geoBlocked: geoDecision.blocked,
    geoKind: geoDecision.kind,
    geoTitle: geoDecision.title,
    geoMessage: geoDecision.message,

    addressStatus: addressCheck.status,
    addressBlocked,
    addressMessage,
    sanctionsUnavailable: addressCheck.unavailable,

    blocked,
    reason,
    assertAllowed,
  }
}