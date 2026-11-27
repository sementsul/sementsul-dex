// Интерфейс: обычный DOM, без React. Причина — размер: React в сборке
// добавил бы ~140 KB, а весь бюджет хранения в блокчейне считается по байтам.
import {
  bySymbol, TOKENS, NATIVE, WBNB, USDT, OWN_POOL, CHAIN_ID, V3_FEE_TIERS, tokenByAddress,
} from './config.js'
import { buildCreatePair, buildCreatePool, tierLabel } from './create.js'
import {
  isSanctioned, sanctionsCount, SANCTIONS_DATE,
  TERMS_TITLE, TERMS_ITEMS, TERMS_ACCEPT, DISCLAIMER,
} from './sanctions.js'
import { fmtAmount, fmtUsd, fmtShort, shortAddr, parseAmount, applySlippage, deadlineFromNow, shortHash } from './format.js'
import {
  discoverPools, loadPoolStates, findBestRoute, loadTokenMeta, loadBalances, loadAllowance,
  toPoolToken, isNative, priceFromSqrt,
} from './pools.js'
import { buildSwap, buildApprove, routerFor } from './swap.js'
import {
  buildAddLiquidityV2, buildRemoveLiquidityV2, buildMintV3, buildBurnV3, buildCollectV3,
  readPosition, amountsForLiquidity, tickFromPrice, priceFromTick, clampTick,
} from './liquidity.js'
import { connect, getProvider, sendTx, onAccountsChanged, onChainChanged, currentChainId } from './wallet.js'
import { callMany } from './rpc.js'
import { SEL, encAddr, decUint, decAddress, decString } from './abi.js'

const state = {
  account: null,
  tab: 'swap',
  from: bySymbol.BNB,
  to: bySymbol.USDT,
  amountIn: '',
  slippage: 50, // 0.5%
  route: null,
  quoting: false,
  balances: {},
  meta: {},
  busy: false,
  notice: null,
  // пул
  pools: [],
  selectedPool: null,
  liqAmounts: { a: '', b: '' },
  v3Range: 5, // проценты
  v3Existing: null,
  // создание пула
  createA: null,
  createB: null,
  createProto: 'v2',
  createFee: 500,
}

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function notify(msg, kind = 'info') {
  state.notice = { msg, kind }
  renderNotice()
  if (kind !== 'error') {
    setTimeout(() => {
      if (state.notice?.msg === msg) {
        state.notice = null
        renderNotice()
      }
    }, 6000)
  }
}

// ---------- отрисовка ----------
function render() {
  renderHeader()
  renderTabs()
  renderNotice()

  // Барьеры проверяются до отрисовки вкладок и перекрывают их целиком.
  // Порядок важен: санкционный адрес не должен даже видеть кнопки записи,
  // а без принятых условий интерфейс не показывается вообще.
  if (sanctionHit) {
    renderSanctioned()
    return
  }
  if (renderTerms()) return

  if (state.tab === 'swap') renderSwap()
  if (state.tab === 'pools') renderPools()
  if (state.tab === 'liq') renderLiquidity()
  if (state.tab === 'create') renderCreate()
}

function renderHeader() {
  const box = $('#wallet')
  box.innerHTML = ''
  if (state.account) {
    const b = el('span', 'addr', shortAddr(state.account))
    const btn = el('button', 'btn ghost small', 'Отключить')
    btn.onclick = () => {
      state.account = null
      state.balances = {}
      render()
    }
    box.append(b, btn)
  } else {
    const btn = el('button', 'btn primary', 'Подключить кошелёк')
    btn.onclick = doConnect
    box.append(btn)
  }
}

function renderTabs() {
  document.querySelectorAll('[data-tab]').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === state.tab)
  })
}

function renderNotice() {
  const box = $('#notice')
  box.innerHTML = ''
  if (!state.notice) return
  const n = el('div', 'notice ' + state.notice.kind, state.notice.msg)
  const x = el('button', 'notice-x', '×')
  x.onclick = () => {
    state.notice = null
    renderNotice()
  }
  n.append(x)
  box.append(n)
}

function tokenSelect(which) {
  const cur = state[which]
  const sel = el('select', 'tok')
  for (const t of TOKENS) {
    const o = el('option', null, t.symbol)
    o.value = t.symbol
    if (t.symbol === cur.symbol) o.selected = true
    sel.append(o)
  }
  sel.onchange = () => {
    const next = bySymbol[sel.value]
    // Если выбрали тот же токен с другой стороны — меняем местами.
    if (next.symbol === state[which === 'from' ? 'to' : 'from'].symbol) {
      state[which === 'from' ? 'to' : 'from'] = cur
    }
    state[which] = next
    state.route = null
    render()
    refreshQuote()
  }
  return sel
}

function renderSwap() {
  const box = $('#view')
  box.innerHTML = ''

  const card = el('div', 'card')

  // --- отдаю ---
  const rowA = el('div', 'row')
  const labA = el('div', 'row-label')
  labA.append(el('span', null, 'Отдаю'))
  const balA = state.balances[state.from.address.toLowerCase()]
  labA.append(el('span', 'muted', balA !== undefined ? 'Баланс: ' + fmtAmount(balA, state.from.decimals, 6) : ''))
  rowA.append(labA)

  const inA = el('div', 'row-input')
  const inpA = el('input', 'amt')
  inpA.type = 'text'
  inpA.inputMode = 'decimal'
  inpA.placeholder = '0.0'
  inpA.value = state.amountIn
  inpA.oninput = () => {
    state.amountIn = inpA.value
    clearTimeout(swapTimer)
    swapTimer = setTimeout(refreshQuote, 350)
  }
  inA.append(inpA, tokenSelect('from'))
  rowA.append(inA)
  card.append(rowA)

  // --- стрелка ---
  const arrow = el('div', 'arrow')
  const sw = el('button', 'swapdir', '↓')
  sw.title = 'Поменять местами'
  sw.onclick = () => {
    const f = state.from
    state.from = state.to
    state.to = f
    state.route = null
    render()
    refreshQuote()
  }
  arrow.append(sw)
  card.append(arrow)

  // --- получаю ---
  const rowB = el('div', 'row')
  const labB = el('div', 'row-label')
  labB.append(el('span', null, 'Получаю'))
  const balB = state.balances[state.to.address.toLowerCase()]
  labB.append(el('span', 'muted', balB !== undefined ? 'Баланс: ' + fmtAmount(balB, state.to.decimals, 6) : ''))
  rowB.append(labB)

  const inB = el('div', 'row-input')
  const outBox = el('div', 'amt out')
  if (state.quoting) outBox.textContent = '…'
  else if (state.route) outBox.textContent = fmtAmount(state.route.out, state.to.decimals, 6)
  else outBox.textContent = '0.0'
  inB.append(outBox, tokenSelect('to'))
  rowB.append(inB)
  card.append(rowB)

  // --- инфо ---
  const info = el('div', 'info')
  if (state.route) {
    const p = state.route.pool
    const price = Number(state.route.out) / 10 ** state.to.decimals
    const inNum = Number(parseAmount(state.amountIn, state.from.decimals)) / 10 ** state.from.decimals
    const rate = inNum > 0 ? price / inNum : 0

    info.append(infoRow('Курс', '1 ' + state.from.symbol + ' = ' + rate.toFixed(6) + ' ' + state.to.symbol))
    info.append(
      infoRow(
        'Пул',
        (p.own ? 'наш ' : 'Pancake ') + (p.protocol === 'v2' ? 'V2' : 'V3 ' + tierLabel(p.fee))
      )
    )
    if (state.route.route.length > 1) info.append(infoRow('Маршрут', 'через WBNB'))

    const slip = applySlippage(state.route.out, state.slippage)
    info.append(infoRow('Минимум', fmtAmount(slip, state.to.decimals, 6) + ' ' + state.to.symbol))
  } else if (state.amountIn && !state.quoting) {
    info.append(infoRow('Пул', 'не найден для этой пары'))
  }
  card.append(info)

  // --- кнопка ---
  const btn = el('button', 'btn primary wide')
  if (!state.account) {
    btn.textContent = 'Подключить кошелёк'
    btn.onclick = doConnect
  } else if (state.busy) {
    btn.textContent = 'Отправляю…'
    btn.disabled = true
  } else if (!state.amountIn || parseAmount(state.amountIn, state.from.decimals) === 0n) {
    btn.textContent = 'Введите сумму'
    btn.disabled = true
  } else if (!state.route) {
    btn.textContent = 'Нет маршрута'
    btn.disabled = true
  } else {
    btn.textContent = 'Обменять ' + state.from.symbol + ' на ' + state.to.symbol
    btn.onclick = doSwap
  }
  card.append(btn)

  // --- слиппедж ---
  const slipRow = el('div', 'slip')
  slipRow.append(el('span', 'muted', 'Допустимое проскальзывание'))
  for (const bps of [10, 50, 100, 200]) {
    // bps -> проценты: 10 -> 0.1, 50 -> 0.5, 100 -> 1, 200 -> 2.
    // Раньше стояло toFixed(bps === 10 ? 1 : 0), из-за чего 50 давало «1%»
    // и две кнопки подряд подписывались одинаково.
    const label = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1) + '%'
    const b = el('button', 'chip' + (state.slippage === bps ? ' on' : ''), label)
    b.onclick = () => {
      state.slippage = bps
      render()
      refreshQuote()
    }
    slipRow.append(b)
  }
  card.append(slipRow)

  box.append(card)
  box.append(renderPoolHint())
}

function infoRow(k, v) {
  const r = el('div', 'info-row')
  r.append(el('span', 'muted', k), el('span', null, v))
  return r
}

function renderPoolHint() {
  const d = el('div', 'hint')
  d.textContent =
    'Курс считается по состоянию пулов на цепи. Своих пулов пока мало, поэтому для большинства пар используется Pancake.'
  return d
}

let swapTimer = null

async function refreshQuote() {
  const amount = parseAmount(state.amountIn, state.from.decimals)
  if (amount === 0n) {
    state.route = null
    state.quoting = false
    render()
    return
  }
  state.quoting = true
  render()
  try {
    const best = await findBestRoute(state.from.address, state.to.address, amount)
    state.route = best
  } catch (e) {
    state.route = null
    notify('Не удалось получить курс: ' + e.message, 'error')
  }
  state.quoting = false
  render()
}

// ---------- действия ----------
async function doConnect() {
  try {
    state.account = await connect()
    notify('Кошелёк подключён: ' + shortAddr(state.account))
    await refreshBalances()
    render()
  } catch (e) {
    const m = e.message === 'NO_WALLET' ? 'Кошелёк не найден. Установите MetaMask.' : e.message
    notify(m, 'error')
  }
}

async function refreshBalances() {
  if (!state.account) return
  try {
    state.balances = await loadBalances(state.account, TOKENS.map((t) => t.address))
  } catch {
    // молча: балансы не критичны для работы
  }
}

async function doSwap() {
  const amount = parseAmount(state.amountIn, state.from.decimals)
  if (!state.route || amount === 0n) return
  const minOut = applySlippage(state.route.out, state.slippage)

  const built = buildSwap({
    route: state.route.route,
    tokenIn: state.from.address,
    tokenOut: state.to.address,
    recipient: state.account,
    amountIn: amount,
    minOut,
    deadline: deadlineFromNow(),
  })
  if (built.error) {
    notify('Маршрут из двух пулов пока не поддерживается в этой версии', 'error')
    return
  }

  state.busy = true
  render()
  try {
    const p = getProvider()
    let list = built.txs

    // approve отдельной транзакцией, если нужен
    if (built.needsApprove) {
      const spender = routerFor(state.route.pool)
      const token = toPoolToken(state.from.address)
      const allow = await loadAllowance(state.account, token, spender)
      if (allow !== null && allow < amount) {
        notify('Подтвердите разрешение на расход токена')
        const tx = buildApprove(token, spender, amount)
        const h = await sendTx(p, state.account, tx)
        notify('Разрешение отправлено: ' + shortHash(h) + ' — ждём подтверждения')
        await waitReceipt(h)
      }
    }

    for (const tx of list) {
      notify('Подтвердите: ' + tx.label)
      const h = await sendTx(p, state.account, tx)
      notify(tx.label + ': ' + shortHash(h) + ' — ждём')
      await waitReceipt(h)
    }

    notify('Готово', 'ok')
    state.amountIn = ''
    state.route = null
    await refreshBalances()
  } catch (e) {
    notify('Ошибка: ' + (e?.shortMessage ?? e?.message ?? 'неизвестно'), 'error')
  }
  state.busy = false
  render()
  refreshQuote()
}

async function waitReceipt(hash) {
  for (let i = 0; i < 120; i++) {
    const [r] = await callMany([{ method: 'eth_getTransactionReceipt', params: [hash] }])
    if (r) {
      if (r.status === '0x0') throw new Error('транзакция отменена в цепи')
      return r
    }
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error('транзакция не подтвердилась за 3 минуты')
}

// ---------- пулы ----------
async function renderPools() {
  const box = $('#view')
  box.innerHTML = ''
  const card = el('div', 'card')
  card.append(el('h2', null, 'Пулы'))

  const pairs = [
    ['BNB', 'USDT'], ['BNB', 'CAKE'], ['BNB', 'BTCB'], ['BNB', 'ETH'],
    ['USDT', 'CAKE'], ['USDT', 'USDC'], ['USDT', 'BTCB'], ['BNB', 'USDC'],
  ]

  const all = []
  for (const [a, b] of pairs) {
    const ta = bySymbol[a]
    const tb = bySymbol[b]
    try {
      const pools = await discoverPools(ta.address, tb.address)
      const states = await loadPoolStates(pools)
      for (const s of states) {
        if (s.ok) all.push({ ta, tb, s })
      }
    } catch {
      // пропускаем пару, если узел не ответил
    }
  }

  all.sort((x, y) => (x.s.own === y.s.own ? 0 : x.s.own ? -1 : 1))

  if (!all.length) {
    card.append(el('div', 'muted', 'Пулы не найдены'))
  } else {
    const tbl = el('div', 'pool-list')
    for (const { ta, tb, s } of all) {
      const row = el('div', 'pool-row' + (s.own ? ' own' : ''))
      const left = el('div', 'pool-name')
      left.append(el('strong', null, ta.symbol + ' / ' + tb.symbol))
      const tags = el('div', 'tags')
      if (s.own) tags.append(el('span', 'tag own', 'наш'))
      tags.append(el('span', 'tag', s.protocol === 'v2' ? 'V2' : 'V3 ' + tierLabel(s.fee)))
      left.append(tags)
      row.append(left)

      const right = el('div', 'pool-right')
      right.append(el('span', 'muted', shortAddr(s.address)))
      row.append(right)

      row.onclick = () => {
        state.selectedPool = { ta, tb, s }
        state.tab = 'liq'
        render()
      }
      tbl.append(row)
    }
    card.append(tbl)
  }

  card.append(
    el(
      'div',
      'hint',
      'Нажатие на пул открывает экран ликвидности. Пулы создаются в отдельной вкладке.'
    )
  )

  const b = el('button', 'btn', 'Создать пул')
  b.onclick = () => {
    state.tab = 'create'
    render()
  }
  card.append(b)
  box.append(card)
}

// ---------- ликвидность ----------
async function renderLiquidity() {
  const box = $('#view')
  box.innerHTML = ''
  const card = el('div', 'card')

  if (!state.selectedPool) {
    card.append(el('h2', null, 'Ликвидность'))
    card.append(el('div', 'muted', 'Выберите пул во вкладке «Пулы».'))
    box.append(card)
    return
  }

  const { ta, tb, s } = state.selectedPool
  card.append(el('h2', null, ta.symbol + ' / ' + tb.symbol + ' — ликвидность'))

  const tags = el('div', 'tags')
  if (s.own) tags.append(el('span', 'tag own', 'наш пул'))
  tags.append(el('span', 'tag', s.protocol === 'v2' ? 'V2' : 'V3 ' + tierLabel(s.fee)))
  tags.append(el('span', 'tag', shortAddr(s.address)))
  card.append(tags)

  if (s.protocol === 'v2') {
    card.append(renderV2Liquidity(ta, tb, s))
  } else {
    await renderV3Liquidity(ta, tb, s, card)
  }

  box.append(card)
}

function renderV2Liquidity(ta, tb, s) {
  const wrap = el('div', 'liq')

  wrap.append(
    el('div', 'hint', 'В V2 вы вносите две монеты в пропорции пула. Доля в пуле пропорциональна вложенному.')
  )

  for (const t of [ta, tb]) {
    const row = el('div', 'row-input')
    const lab = el('div', 'row-label')
    const bal = state.balances[t.address.toLowerCase()]
    lab.append(el('span', null, t.symbol))
    lab.append(el('span', 'muted', bal !== undefined ? 'Есть: ' + fmtAmount(bal, t.decimals, 6) : ''))
    const inp = el('input', 'amt')
    inp.type = 'text'
    inp.inputMode = 'decimal'
    inp.placeholder = '0.0'
    inp.value = t === ta ? state.liqAmounts.a : state.liqAmounts.b
    inp.oninput = () => {
      if (t === ta) state.liqAmounts.a = inp.value
      else state.liqAmounts.b = inp.value
    }
    row.append(inp)
    const box = el('div', 'liq-col')
    box.append(lab, row)
    wrap.append(box)
  }

  const add = el('button', 'btn primary wide', 'Добавить ликвидность')
  add.onclick = () => doAddV2(ta, tb, s)
  wrap.append(add)

  return wrap
}

async function renderV3Liquidity(ta, tb, s, card) {
  const wrap = el('div', 'liq')

  // Цена в V3 хранится как token1/token0, где token0 — меньший адрес.
  // Считаем оба направления и подписываем явно, иначе легко показать
  // «1 USDT = 566 BNB» вместо «1 BNB = 566 USDT». Именно так и вышло
  // в первой версии: price01 считается как (sqrtP/2^96)^2 и это цена
  // token0 в token1, а не наоборот.
  const sqrtP = s.sqrtPriceX96
  const price01 = priceFromSqrt(sqrtP) // сколько token1 за 1 token0
  const t0 = ta.address.toLowerCase() < tb.address.toLowerCase() ? ta : tb
  const t1 = t0 === ta ? tb : ta

  wrap.append(
    el('div', 'hint', 'V3: ликвидность вносится в выбранный диапазон цены. Вне диапазона позиция перестаёт зарабатывать.')
  )

  const priceRow = el('div', 'info')
  // token0 = USDT, token1 = WBNB -> price01 это WBNB за USDT (маленькое число).
  // Показываем в «человеческом» виде: сколько котируемого за 1 базовый.
  const human = price01 >= 1 ? '1 ' + t0.symbol + ' = ' + price01.toFixed(6) + ' ' + t1.symbol
                             : '1 ' + t1.symbol + ' = ' + (1 / price01).toFixed(6) + ' ' + t0.symbol
  priceRow.append(infoRow('Текущая цена', human))
  const tickNow = Math.round(Math.log(price01) / Math.log(1.0001))
  priceRow.append(infoRow('Тик', String(tickNow)))
  wrap.append(priceRow)

  // диапазон
  const rangeRow = el('div', 'slip')
  rangeRow.append(el('span', 'muted', 'Диапазон'))
  for (const pct of [1, 5, 10, 25, 50]) {
    const b = el('button', 'chip' + (state.v3Range === pct ? ' on' : ''), '±' + pct + '%')
    b.onclick = () => {
      state.v3Range = pct
      render()
    }
    rangeRow.append(b)
  }
  wrap.append(rangeRow)

  const spacing = s.fee === 50 ? 1 : s.fee === 500 ? 10 : s.fee === 2500 ? 50 : 200
  const lowerPrice = price01 * (1 - state.v3Range / 100)
  const upperPrice = price01 * (1 + state.v3Range / 100)
  const tickLower = clampTick(tickFromPrice(lowerPrice, spacing), spacing)
  const tickUpper = clampTick(tickFromPrice(upperPrice, spacing), spacing)

  const rangeInfo = el('div', 'info')
  // Подписываем границы в тех же единицах, что и текущую цену выше.
  // И ещё одна тонкость: tickLower соответствует МЕНЬШЕМУ sqrtPrice, то
  // есть меньшей цене token0 в token1. Если показывать «в лоб» (1/p), то
  // в перевёрнутых единицах нижняя граница выглядит БОЛЬШЕ верхней, и
  // получается «нижняя 596, верхняя 539» при текущей 566. Поэтому
  // пересчитываем в перевёрнутые единицы и меняем подписи местами.
  const flipped = price01 < 1
  const pLow = priceFromTick(tickLower)
  const pHigh = priceFromTick(tickUpper)
  const lo = flipped ? 1 / pHigh : pLow
  const hi = flipped ? 1 / pLow : pHigh
  const unit = flipped ? t0.symbol + ' за 1 ' + t1.symbol : t1.symbol + ' за 1 ' + t0.symbol

  rangeInfo.append(infoRow('Нижняя граница', lo.toFixed(6) + ' ' + unit))
  rangeInfo.append(infoRow('Верхняя граница', hi.toFixed(6) + ' ' + unit))
  rangeInfo.append(infoRow('Шаг тика', String(spacing)))
  wrap.append(rangeInfo)

  // Сколько вкладываем — задаём по token0
  const row = el('div', 'row-input')
  const lbl = el('div', 'row-label')
  const bal0 = state.balances[t0.address.toLowerCase()]
  lbl.append(el('span', null, 'Сколько ' + t0.symbol))
  lbl.append(el('span', 'muted', bal0 !== undefined ? 'Есть: ' + fmtAmount(bal0, t0.decimals, 6) : ''))
  const inp = el('input', 'amt')
  inp.type = 'text'
  inp.inputMode = 'decimal'
  inp.placeholder = '0.0'
  inp.value = state.liqAmounts.a
  inp.oninput = () => {
    state.liqAmounts.a = inp.value
  }
  row.append(inp)
  const col = el('div', 'liq-col')
  col.append(lbl, row)
  wrap.append(col)

  // Существующая позиция
  if (state.account) {
    try {
      state.v3Existing = await readPosition(s.address, state.account, tickLower, tickUpper, callMany)
      if (state.v3Existing && state.v3Existing.liquidity > 0n) {
        const amts = amountsForLiquidity(sqrtP, tickLower, tickUpper, state.v3Existing.liquidity)
        const ex = el('div', 'info existing')
        ex.append(el('strong', null, 'Ваша позиция в этом диапазоне'))
        ex.append(infoRow('Ликвидность', fmtShort(state.v3Existing.liquidity, 18)))
        ex.append(infoRow('Сейчас в ней', fmtAmount(amts.amount0, t0.decimals, 6) + ' ' + t0.symbol))
        ex.append(infoRow('', fmtAmount(amts.amount1, t1.decimals, 6) + ' ' + t1.symbol))
        if (state.v3Existing.tokensOwed0 > 0n || state.v3Existing.tokensOwed1 > 0n) {
          ex.append(
            infoRow(
              'К сбору',
              fmtAmount(state.v3Existing.tokensOwed0, t0.decimals, 6) +
                ' ' + t0.symbol + ' + ' +
                fmtAmount(state.v3Existing.tokensOwed1, t1.decimals, 6) + ' ' + t1.symbol
            )
          )
        }
        wrap.append(ex)

        const rm = el('button', 'btn', 'Вывести всю ликвидность')
        rm.onclick = () => doRemoveV3(s, tickLower, tickUpper, state.v3Existing.liquidity, t0, t1)
        wrap.append(rm)

        const cl = el('button', 'btn', 'Собрать комиссии')
        cl.onclick = () => doCollectV3(s, tickLower, tickUpper)
        wrap.append(cl)
      }
    } catch {
      // позиция не читается — не критично
    }
  }

  const add = el('button', 'btn primary wide', 'Добавить ликвидность')
  add.onclick = () => doAddV3(s, t0, t1, tickLower, tickUpper)
  wrap.append(add)

  card.append(wrap)
}

async function doAddV2(ta, tb, s) {
  const a = parseAmount(state.liqAmounts.a, ta.decimals)
  const b = parseAmount(state.liqAmounts.b, tb.decimals)
  if (a === 0n || b === 0n) {
    notify('Введите обе суммы', 'error')
    return
  }
  state.busy = true
  render()
  try {
    const p = getProvider()
    const router = s.own ? V2_ROUTER_FALLBACK : PANCAKE_ROUTER_FALLBACK
    for (const [tok, amt] of [[ta, a], [tb, b]]) {
      if (isNative(tok.address)) continue
      const allow = await loadAllowance(state.account, tok.address, router)
      if (allow !== null && allow < amt) {
        notify('Разрешение для ' + tok.symbol)
        const h = await sendTx(p, state.account, buildApprove(tok.address, router, amt))
        await waitReceipt(h)
      }
    }
    const tx = buildAddLiquidityV2({
      tokenA: ta.address, tokenB: tb.address, amountA: a, amountB: b,
      minA: applySlippage(a, state.slippage), minB: applySlippage(b, state.slippage),
      recipient: state.account, deadline: deadlineFromNow(), own: s.own,
    })
    notify('Подтвердите добавление ликвидности')
    const h = await sendTx(p, state.account, tx)
    notify('Отправлено: ' + shortHash(h))
    await waitReceipt(h)
    notify('Ликвидность добавлена', 'ok')
    await refreshBalances()
  } catch (e) {
    notify('Ошибка: ' + (e?.message ?? 'неизвестно'), 'error')
  }
  state.busy = false
  render()
}

async function doAddV3(s, t0, t1, tickLower, tickUpper) {
  const amt0 = parseAmount(state.liqAmounts.a, t0.decimals)
  if (amt0 === 0n) {
    notify('Введите сумму', 'error')
    return
  }
  // Переводим сумму token0 в ликвидность: L = amount0 * sqrtA*sqrtB / (sqrtB - sqrtA) * Q96
  const { sqrtAtTick } = await import('./liquidity.js')
  const Q96 = 1n << 96n
  const sa = sqrtAtTick(tickLower)
  const sb = sqrtAtTick(tickUpper)
  const L = (amt0 * sa * sb) / (Q96 * (sb - sa))
  if (L === 0n) {
    notify('Слишком маленькая сумма для этого диапазона', 'error')
    return
  }
  const amts = amountsForLiquidity(s.sqrtPriceX96, tickLower, tickUpper, L)

  state.busy = true
  render()
  try {
    const p = getProvider()
    for (const [tok, amt] of [[t0, amts.amount0], [t1, amts.amount1]]) {
      if (isNative(tok.address) || amt === 0n) continue
      const allow = await loadAllowance(state.account, tok.address, s.address)
      if (allow !== null && allow < amt) {
        notify('Разрешение для ' + tok.symbol + ' (пул)')
        const h = await sendTx(p, state.account, buildApprove(tok.address, s.address, amt))
        await waitReceipt(h)
      }
    }
    const tx = buildMintV3({ pool: s.address, recipient: state.account, tickLower, tickUpper, liquidity: L })
    notify('Подтвердите: нужно ' + fmtAmount(amts.amount0, t0.decimals, 6) + ' ' + t0.symbol + ' и ' + fmtAmount(amts.amount1, t1.decimals, 6) + ' ' + t1.symbol)
    const h = await sendTx(p, state.account, tx)
    await waitReceipt(h)
    notify('Позиция создана', 'ok')
    await refreshBalances()
  } catch (e) {
    notify('Ошибка: ' + (e?.message ?? 'неизвестно'), 'error')
  }
  state.busy = false
  render()
}

async function doRemoveV3(s, tickLower, tickUpper, liquidity, t0, t1) {
  state.busy = true
  render()
  try {
    const p = getProvider()
    const burn = buildBurnV3({ pool: s.address, tickLower, tickUpper, liquidity })
    notify('Подтвердите вывод ликвидности')
    const h1 = await sendTx(p, state.account, burn)
    await waitReceipt(h1)
    const col = buildCollectV3({ pool: s.address, recipient: state.account, tickLower, tickUpper })
    notify('Подтвердите сбор токенов')
    const h2 = await sendTx(p, state.account, col)
    await waitReceipt(h2)
    notify('Ликвидность выведена', 'ok')
    await refreshBalances()
  } catch (e) {
    notify('Ошибка: ' + (e?.message ?? 'неизвестно'), 'error')
  }
  state.busy = false
  render()
}

async function doCollectV3(s, tickLower, tickUpper) {
  state.busy = true
  render()
  try {
    const p = getProvider()
    const tx = buildCollectV3({ pool: s.address, recipient: state.account, tickLower, tickUpper })
    notify('Подтвердите сбор комиссий')
    const h = await sendTx(p, state.account, tx)
    await waitReceipt(h)
    notify('Комиссии собраны', 'ok')
    await refreshBalances()
  } catch (e) {
    notify('Ошибка: ' + (e?.message ?? 'неизвестно'), 'error')
  }
  state.busy = false
  render()
}

const V2_ROUTER_FALLBACK = '0x2069336bD5E70c4F359Ff4142a8B072D074cbbe6'
const PANCAKE_ROUTER_FALLBACK = '0x10ED43C718714eb63d5aA57B78B54704E256024E'

// ---------- создание пула ----------
//
// Экран делает две вещи: показывает существующие пулы для выбранной пары
// (чтобы не создавать дубль и не платить газ дважды) и даёт создать новый
// в V2 или V3 с выбранным тиром.
//
// Важная деталь про V2: createPair на существующую пару не откатывается,
// а возвращает адрес уже созданного пула. Транзакция пройдёт, газ спишется,
// а пула не прибавится. Поэтому сначала смотрим getPair и говорим прямо.
async function renderCreate() {
  const box = $('#view')
  box.innerHTML = ''
  const card = el('div', 'card')
  card.append(el('h2', null, 'Создать пул'))
  card.append(
    el(
      'div',
      'hint',
      'Пул создаётся в нашей фабрике на BNB Chain. После создания в него нужно добавить ликвидность: пустой пул не торгуется.'
    )
  )

  // Пара
  const pairRow = el('div', 'liq')
  const c1 = el('div', 'liq-col')
  c1.append(el('div', 'row-label', 'Первый токен'))
  const s1 = el('select', 'tok')
  for (const t of TOKENS) {
    const o = document.createElement('option')
    o.value = t.address
    o.textContent = t.symbol
    s1.append(o)
  }
  s1.value = state.createA ?? TOKENS[0].address
  c1.append(s1)
  pairRow.append(c1)

  const c2 = el('div', 'liq-col')
  c2.append(el('div', 'row-label', 'Второй токен'))
  const s2 = el('select', 'tok')
  for (const t of TOKENS) {
    const o = document.createElement('option')
    o.value = t.address
    o.textContent = t.symbol
    s2.append(o)
  }
  s2.value = state.createB ?? TOKENS[1].address
  c2.append(s2)
  pairRow.append(c2)
  card.append(pairRow)

  // Протокол
  const protoWrap = el('div', 'liq-col')
  protoWrap.append(el('div', 'row-label', 'Версия'))
  const chips = el('div', 'slip')
  const protos = [
    { id: 'v2', label: 'V2 (простая)' },
    { id: 'v3', label: 'V3 (диапазоны)' },
  ]
  const proto = state.createProto ?? 'v2'
  for (const p of protos) {
    const b = el('button', 'chip' + (proto === p.id ? ' on' : ''), p.label)
    b.onclick = () => {
      state.createProto = p.id
      render()
    }
    chips.append(b)
  }
  protoWrap.append(chips)
  card.append(protoWrap)

  // Тир для V3
  if (proto === 'v3') {
    const feeWrap = el('div', 'liq-col')
    feeWrap.append(el('div', 'row-label', 'Комиссия'))
    const feeChips = el('div', 'slip')
    const fee = state.createFee ?? 500
    for (const f of V3_FEE_TIERS) {
      const b = el('button', 'chip' + (fee === f ? ' on' : ''), tierLabel(f))
      b.onclick = () => {
        state.createFee = f
        render()
      }
      feeChips.append(b)
    }
    feeWrap.append(feeChips)
    feeWrap.append(
      el('div', 'hint', 'У Pancake есть тир 0.01%, но наша фабрика его не поддерживает. Доступны только четыре выше.')
    )
    card.append(feeWrap)
  }

  const ta = tokenByAddress(s1.value)
  const tb = tokenByAddress(s2.value)

  // Что уже существует
  const existing = el('div', 'existing')
  existing.append(el('strong', null, 'Уже существуют'))
  const existingList = el('div', 'pool-list')
  existingList.append(el('div', 'muted', 'Проверяю…'))
  existing.append(existingList)
  card.append(existing)

  s1.onchange = () => {
    state.createA = s1.value
    render()
  }
  s2.onchange = () => {
    state.createB = s2.value
    render()
  }

  // Кнопка создания
  const btn = el('button', 'btn primary', 'Создать пул')
  btn.disabled = true
  card.append(btn)

  box.append(card)

  if (!ta || !tb || ta.address.toLowerCase() === tb.address.toLowerCase()) {
    existingList.innerHTML = ''
    existingList.append(el('div', 'muted', 'Выберите два разных токена'))
    return
  }

  // Ищем существующие пулы по обоим фабрикам
  const found = await discoverPools(ta.address, tb.address)
  existingList.innerHTML = ''
  if (found.length) {
    for (const s of found) {
      const row = el('div', 'pool-row' + (s.own ? ' own' : ''))
      const left = el('div', 'pool-name')
      left.append(el('strong', null, ta.symbol + ' / ' + tb.symbol))
      const tags = el('div', 'tags')
      if (s.own) tags.append(el('span', 'tag own', 'наш'))
      tags.append(el('span', 'tag', s.protocol === 'v2' ? 'V2' : 'V3 ' + tierLabel(s.fee)))
      left.append(tags)
      row.append(left)
      const right = el('div', 'pool-right')
      right.append(el('span', 'muted', shortAddr(s.address)))
      row.append(right)
      row.onclick = () => {
        state.selectedPool = { ta, tb, s }
        state.tab = 'liq'
        render()
      }
      existingList.append(row)
    }
  } else {
    existingList.append(el('div', 'muted', 'Пулов для этой пары пока нет ни у нас, ни у Pancake'))
  }

  // Есть ли уже такой пул у нас — по выбранной версии и тиру
  const ourSame = found.find(
    (s) => s.own && s.protocol === proto && (proto === 'v2' || s.fee === (state.createFee ?? 500))
  )

  if (ourSame) {
    btn.textContent = 'Такой пул уже есть'
    btn.disabled = true
    const go = el('button', 'btn', 'Добавить ликвидность')
    go.onclick = () => {
      state.selectedPool = { ta, tb, s: ourSame }
      state.tab = 'liq'
      render()
    }
    card.append(go)
    return
  }

  btn.disabled = false
  btn.textContent = proto === 'v2' ? 'Создать пул V2' : 'Создать пул V3 ' + tierLabel(state.createFee ?? 500)
  btn.onclick = () => doCreate(ta, tb, proto, state.createFee ?? 500)
}

async function doCreate(ta, tb, proto, fee) {
  if (!state.account) {
    await doConnect()
    if (!state.account) return
  }
  const tx =
    proto === 'v2' ? buildCreatePair(ta.address, tb.address) : buildCreatePool(ta.address, tb.address, fee)

  if (tx.error) {
    notice(tx.message, 'error')
    return
  }

  state.busy = true
  notice('Подтвердите создание пула в кошельке', 'ok')
  try {
    const hash = await sendTx({ to: tx.to, data: tx.data, value: 0n, gas: 3_000_000n })
    notice('Транзакция отправлена, ждём подтверждения', 'ok')
    const r = await waitReceipt(hash)
    if (r.status !== 'success') {
      notice('Транзакция не прошла. Возможно, пул уже существует.', 'error')
      state.busy = false
      return
    }
    notice('Пул создан: ' + shortHash(hash), 'ok')

    // Обновляем список пулов, чтобы новый появился сразу.
    state.pools = null
    state.tab = 'pools'
    state.busy = false
    render()
  } catch (e) {
    notice(errText(e), 'error')
    state.busy = false
  }
}

// ---------- условия и санкционный барьер ----------
//
// Два независимых барьера:
//
//   1. Условия при первом входе. Показываются один раз, согласие
//      запоминается в localStorage. Это не юридическая защита сама по себе,
//      но фиксирует, что человек видел раскрытие рисков.
//
//   2. Проверка адреса кошелька по вшитому списку OFAC SDN. Срабатывает
//      при подключении и при каждой смене аккаунта. Если адрес найден —
//      кнопки записи блокируются, остаётся только чтение.
//
// Чего здесь НЕТ и почему. Геоблокировки нет: браузер не знает IP, а
// спросить сервер нельзя — у on-chain версии сервера нет по определению.
// Настоящая геоблокировка живёт на уровне домена (см. functions/api/geo.js
// и правила Cloudflare для /chain/), а здесь только предупреждение текстом.
// Это надо понимать буквально: если человек откроет страницу по прямому
// хешу транзакции, минуя sementsul.net, геоблокировки не будет вовсе.
//
// Список вшит на момент публикации и не обновляется сам. OFAC меняет SDN
// несколько раз в месяц, поэтому проверка — барьер, а не гарантия.

const TERMS_KEY = 'sementsul:terms:v1'

// Результат проверки текущего адреса. null — адрес не проверялся или чист.
let sanctionHit = null

// Показаны ли условия. Читаем из localStorage, но не падаем, если он
// недоступен: в приватном режиме и при запрете сторонних данных доступ
// к нему бросает исключение, а интерфейс должен открыться всё равно.
function termsAccepted() {
  try {
    return localStorage.getItem(TERMS_KEY) === '1'
  } catch (e) {
    return false
  }
}

function acceptTerms() {
  try {
    localStorage.setItem(TERMS_KEY, '1')
  } catch (e) {
    // Не смогли запомнить — не страшно, спросим в следующий раз.
  }
}

// Проверяет адрес и запоминает результат. Вызывается при подключении и при
// смене аккаунта в кошельке: иначе можно подключить чистый адрес, а потом
// переключиться на санкционный и продолжить работу.
function checkSanctions(address) {
  sanctionHit = address && isSanctioned(address) ? address : null
  return sanctionHit
}

// Экран условий. Возвращает true, если условия показаны и дальше рисовать
// интерфейс не нужно.
function renderTerms() {
  if (termsAccepted()) return false

  const box = $('#view')
  box.innerHTML = ''
  const card = el('div', 'card')
  card.append(el('h2', null, TERMS_TITLE))

  const list = el('div', 'terms')
  for (const item of TERMS_ITEMS) {
    list.append(el('div', 'terms-item', item))
  }
  card.append(list)

  const facts = el('div', 'info')
  facts.append(infoRow('Список санкций', sanctionsCount() + ' адресов, на ' + SANCTIONS_DATE))
  facts.append(infoRow('Сеть', 'BNB Chain (56)'))
  card.append(facts)

  const b = el('button', 'btn primary', TERMS_ACCEPT)
  b.onclick = () => {
    acceptTerms()
    render()
  }
  card.append(b)

  box.append(card)
  return true
}

// Экран блокировки по санкциям. Показывается вместо интерфейса целиком:
// оставлять вкладки активными при санкционном адресе бессмысленно и опасно.
function renderSanctioned() {
  const box = $('#view')
  box.innerHTML = ''
  const card = el('div', 'card')
  card.append(el('h2', null, 'Адрес заблокирован'))
  card.append(
    el(
      'div',
      'hint',
      'Подключённый адрес найден в санкционном списке OFAC SDN. Операции обмена и предоставления ликвидности недоступны.'
    )
  )
  const facts = el('div', 'info')
  facts.append(infoRow('Адрес', shortAddr(sanctionHit)))
  facts.append(infoRow('Список', sanctionsCount() + ' адресов, на ' + SANCTIONS_DATE))
  card.append(facts)
  card.append(
    el(
      'div',
      'hint',
      'Если вы считаете это ошибкой — проверка идёт по официальному перечню OFAC SDN. Список вшит в страницу на дату публикации и не обновляется автоматически.'
    )
  )

  const b = el('button', 'btn', 'Отключить кошелёк')
  b.onclick = () => {
    state.account = null
    state.balances = {}
    checkSanctions(null)
    render()
  }
  card.append(b)

  box.append(card)
}

// ---------- запуск ----------
export function start() {
  const provider = getProvider()
  if (provider) {
    provider.request({ method: 'eth_accounts' }).then((a) => {
      if (a?.length) {
        state.account = a[0]
        checkSanctions(a[0])
        refreshBalances().then(render)
      }
    })
    onAccountsChanged((acc) => {
      state.account = acc
      state.balances = {}
      // Переключение на другой адрес в кошельке — это новый субъект.
      // Без повторной проверки можно подключить чистый адрес, а потом
      // сменить его на санкционный и продолжить работу.
      checkSanctions(acc)
      refreshBalances().then(render)
      render()
    })
    onChainChanged(() => render())
  }

  document.querySelectorAll('[data-tab]').forEach((t) => {
    t.onclick = () => {
      state.tab = t.dataset.tab
      render()
    }
  })

  render()

  // Автообновление курса раз в 20 секунд, если вкладка открыта
  setInterval(() => {
    if (state.tab === 'swap' && state.amountIn && !state.busy) refreshQuote()
  }, 20000)
}

// Экспорт для сборки: точка входа одна.
export { render, state }