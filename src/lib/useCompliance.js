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

/// Опрашивает гео-эндпоинт.
///
/// Возвращает объект с полем status:
///   'ok'          — страна получена, можно судить о блокировке;
///   'unavailable' — эндпоинта нет или он не ответил (IPFS-зеркало, локальная
///                   разработка без wrangler, сбой сети).
///
/// Различать эти два случая обязательно. Раньше при любой ошибке возвращался
/// просто null, evaluateGeo(null) давал «не заблокировано», и на IPFS-зеркале
/// санкционный барьер тихо исчезал: посетитель из США видел рабочий интерфейс
/// без единого упоминания, что проверка не проводилась.
///
/// Теперь отсутствие проверки — отдельное состояние, и интерфейс говорит о нём
/// прямо (см. geoUnavailable в возвращаемом объекте).
async function fetchGeo() {
  try {
    const res = await fetch('/api/geo', { cache: 'no-store' })
    if (!res.ok) return { status: 'unavailable' }
    const data = await res.json()
    // Защита от SPA-фолбэка: при отсутствии функции Pages отдаст index.html
    // со статусом 200, и json() упадёт — это нормально, ловим.
    if (!data || typeof data !== 'object' || !('country' in data)) {
      return { status: 'unavailable' }
    }
    return { status: 'ok', geo: data }
  } catch {
    return { status: 'unavailable' }
  }
}

export function useCompliance(account, t = null) {
  const [geo, setGeo] = useState(null)
  const [geoLoaded, setGeoLoaded] = useState(false)
  // Отдельное состояние: проверка не выполнена. Именно оно отличает зеркало
  // от «проверили и пропустили».
  const [geoUnavailable, setGeoUnavailable] = useState(false)
  const [addressCheck, setAddressCheck] = useState({
    status: 'idle', // idle | checking | ok | listed | error
    entry: null,
    unavailable: false,
  })

  // ---------- геолокация ----------
  useEffect(() => {
    let alive = true
    fetchGeo().then((r) => {
      if (!alive) return
      setGeo(r.status === 'ok' ? r.geo : null)
      setGeoUnavailable(r.status === 'unavailable')
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

  const geoDecision = useMemo(() => evaluateGeo(geo, t), [geo, t])

  const addressBlocked = addressCheck.status === 'listed'
  const addressMessage = addressBlocked ? describeAddressBlock(addressCheck.entry, t) : null

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
    // Проверка юрисдикции не выполнялась (IPFS-зеркало или сбой эндпоинта).
    // Интерфейс обязан сказать об этом, а не делать вид, что всё проверено.
    geoUnavailable,
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