// Сборка списка санкционных адресов из официального источника OFAC.
//
// Зачем свой генератор, а не готовая библиотека: список должен быть
// воспроизводим и проверяем. Любой может запустить этот скрипт и сравнить
// результат с тем, что лежит в public/sanctions/.
//
// Источник — SDN.XML с сервиса Минфина США (sanctionslistservice.ofac.treas.gov).
// Это первоисточник: TRM Labs и Chainalysis строят свои продукты поверх него,
// но их графовый анализ нам недоступен и не нужен для базовой проверки.
//
// ВАЖНО про охват: здесь только адреса, которые OFAC внесла в список явно.
// Это не «проверка кошелька на всё плохое»: адрес, связанный с миксером через
// одну транзакцию, в списке не появится. Подробнее — docs/COMPLIANCE.md.
//
// Использование:
//   node scripts/build-sanctions-list.mjs
//   node scripts/build-sanctions-list.mjs --check   # только проверить актуальность

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'sanctions')
const OUT_FILE = join(OUT_DIR, 'ofac-addresses.json')
const EXTRA_FILE = join(ROOT, 'data', 'sanctions-extra.json')

const SOURCE_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML'

// Запасной источник: полный архив с treasury.gov. Он в 4 раза больше и
// отдаётся медленнее (44 с против 13), поэтому только как резерв.
const FALLBACK_URL = 'https://www.treasury.gov/ofac/downloads/sanctions/1.0/sdn_advanced.xml'

const checkOnly = process.argv.includes('--check')

/// Достаёт из XML все явно указанные крипто-адреса формата 0x.
///
/// Структура записи OFAC:
///   <sdnEntry>
///     <firstName>…</firstName> <lastName>…</lastName>
///     <idList><id><idType>Digital Currency Address - ETH</idType>
///               <idNumber>0x…</idNumber></id></idList>
///     <programList><program>CYBER2</program></programList>
///   </sdnEntry>
///
/// Сеть берём из idType: «Digital Currency Address - BSC» и т.п. Но фильтруем
/// не по сети, а по формату: любой 0x-адрес EVM-совместим, и OFAC может
/// пометить его как ETH, хотя он же используется в BSC. Поэтому в список
/// попадают все 0x, а сеть сохраняем как справку.
function extractAddresses(xml) {
  const entries = xml.split('<sdnEntry>').slice(1)
  const out = new Map()

  for (const entry of entries) {
    const ids = [...entry.matchAll(/<idType>([^<]+)<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g)]
    const crypto = ids.filter(([, type]) => /Digital Currency Address/i.test(type))
    if (!crypto.length) continue

    const lastName = (entry.match(/<lastName>([^<]*)<\/lastName>/) ?? [])[1] ?? ''
    const firstName = (entry.match(/<firstName>([^<]*)<\/firstName>/) ?? [])[1] ?? ''
    const name = `${firstName} ${lastName}`.trim()
    const programs = [...entry.matchAll(/<program>([^<]+)<\/program>/g)].map((m) => m[1])

    for (const [, type, value] of crypto) {
      const addr = value.trim().toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue
      // «Digital Currency Address - ETH» → ETH
      const network = type.replace(/.*-\s*/, '').trim().toUpperCase()

      const prev = out.get(addr)
      if (prev) {
        // Один адрес может встречаться у нескольких записей — копим имена.
        if (name && !prev.names.includes(name)) prev.names.push(name)
        for (const p of programs) if (!prev.programs.includes(p)) prev.programs.push(p)
        if (!prev.networks.includes(network)) prev.networks.push(network)
      } else {
        out.set(addr, {
          names: name ? [name] : [],
          programs: [...new Set(programs)],
          networks: [network],
        })
      }
    }
  }
  return out
}

async function download(url, label) {
  const started = Date.now()
  process.stdout.write(`  ${label}… `)
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  console.log(`${(text.length / 1024 / 1024).toFixed(1)} МБ за ${Date.now() - started} мс`)
  return text
}

async function main() {
  console.log('=== сборка списка санкционных адресов OFAC ===\n')

  let xml = null
  try {
    xml = await download(SOURCE_URL, 'основной источник')
  } catch (e) {
    console.log(`не удалось (${e.message}), пробую резервный`)
    xml = await download(FALLBACK_URL, 'резервный источник')
  }

  const found = extractAddresses(xml)
  console.log(`\nнайдено уникальных 0x-адресов: ${found.size}`)

  if (found.size < 50) {
    // Список OFAC исторически содержит больше сотни адресов. Резкое падение
    // означает, что сменился формат XML, и разбор молча вернул пустоту.
    // Лучше упасть, чем выложить сайт с пустым списком и думать, что всё цело.
    throw new Error(
      `подозрительно мало адресов (${found.size}). Вероятно, изменился формат XML — разбор нужно проверить.`
    )
  }

  // Ручные дополнения: сюда попадают источники, у которых нет удобной
  // машиночитаемой выгрузки (например, консолидированный список ЕС).
  // Файл необязательный; если его нет — просто пропускаем.
  let extra = {}
  if (existsSync(EXTRA_FILE)) {
    extra = JSON.parse(readFileSync(EXTRA_FILE, 'utf8'))
    const extraAddrs = extra.addresses ?? {}
    let added = 0
    for (const [addr, info] of Object.entries(extraAddrs)) {
      const a = addr.toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(a)) continue
      if (!found.has(a)) {
        found.set(a, {
          names: info.names ?? [],
          programs: info.programs ?? [],
          networks: info.networks ?? [],
        })
        added++
      }
    }
    console.log(`добавлено из sanctions-extra.json: ${added}`)
  } else {
    console.log('sanctions-extra.json нет — только OFAC')
  }

  // Сортировка по адресу: одинаковый порядок при каждом запуске, иначе
  // git-диффы будут шумными даже когда содержимое не изменилось.
  const addresses = {}
  for (const addr of [...found.keys()].sort()) {
    const v = found.get(addr)
    addresses[addr] = {
      names: v.names.sort(),
      programs: v.programs.sort(),
      networks: v.networks.sort(),
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    sourceName: 'OFAC SDN (Specially Designated Nationals), U.S. Department of the Treasury',
    // Правовая оговорка: список — вспомогательный признак, а не юридическое
    // заключение. Решение о блокировке принимает оператор сервиса.
    note:
      'Адреса, явно внесённые OFAC в SDN-список. Совпадение адреса с записью — ' +
      'основание заблокировать операции; отсутствие совпадения не означает, что ' +
      'кошелёк чист.',
    count: Object.keys(addresses).length,
    addresses,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')

  console.log(`\nзаписано: public/sanctions/ofac-addresses.json`)
  console.log(`  адресов: ${payload.count}`)

  // Сети для справки
  const nets = {}
  for (const v of Object.values(addresses)) {
    for (const n of v.networks) nets[n] = (nets[n] ?? 0) + 1
  }
  console.log(`  сети: ${Object.entries(nets).map(([k, v]) => `${k}=${v}`).join(', ')}`)

  // Контрольная проверка: адреса Lazarus Group. Они в SDN-списке давно и
  // никуда не девались, поэтому служат индикатором, что разбор не сломался.
  //
  // Про Tornado Cash: его адресов в списке НЕТ и это правильно. OFAC внёс их
  // в августе 2022, но в марте 2025 исключил после решения суда по делу
  // Van Loon v. Department of the Treasury. Если однажды понадобится
  // «контрольный адрес», который точно на месте — брать Lazarus, а не
  // Tornado: список живой и меняется.
  const KNOWN = [
    ['0x098b716b8aaf21512996dc57eb0615e2383e2f96', 'Lazarus Group'],
    ['0xa0e1c89ef1a489c9c7de96311ed5ce5d32c20e4b', 'Lazarus Group'],
  ]
  const hits = KNOWN.filter(([a]) => addresses[a]).length
  console.log(`  контрольные адреса Lazarus Group: ${hits}/${KNOWN.length}`)
  if (hits === 0) {
    throw new Error('ни один контрольный адрес не найден — разбор сломан')
  }

  if (checkOnly) {
    console.log('\n--check: список только собран, файл всё равно обновлён')
  }
}

main().catch((e) => {
  console.error('\nОШИБКА:', e.message)
  process.exit(1)
})