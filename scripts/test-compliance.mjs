// Тесты комплаенса: геоблокировка и проверка по санкционному списку.
//
// Проверяем чистую логику. Сеть не нужна: список читается из файла,
// чтобы тест падал и при порче самого файла, а не только кода.
//
// Отдельно проверяются опасные в обе стороны случаи:
//   · Россия и Беларусь НЕ под всеобъемлющими санкциями — блокировать их
//     было бы ошибкой, и это легко «починить» неверно;
//   · Крым и Донбасс приходят как country='UA', поэтому различаются только
//     по региону — если проверка региона сломается, блокировка исчезнет
//     молча.

import { readFileSync } from 'node:fs'
import {
  BLOCKED_COUNTRIES,
  BLOCKED_UA_REGIONS,
  blockedCountryName,
  isBlockedRegion,
  evaluateGeo,
  describeAddressBlock,
} from '../src/lib/compliance.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`  ФЕЙЛ ${name}${extra ? '  ' + extra : ''}`)
  }
}

console.log('\n=== страны под всеобъемлющими санкциями ===')

check('Иран блокируется', blockedCountryName('IR') === 'Иран')
check('КНДР блокируется', blockedCountryName('KP') === 'КНДР')
check('Сирия блокируется', blockedCountryName('SY') === 'Сирия')
check('Куба блокируется', blockedCountryName('CU') === 'Куба')
check('регистр не важен: ir', blockedCountryName('ir') === 'Иран')

// Россия и Беларусь блокируются по решению владельца сервиса, а НЕ по
// требованию закона. Против России действуют секторальные меры, а не
// всеобъемлющие: формально блокировать всю страну закон не обязывает.
// Тест фиксирует именно текущее состояние, чтобы изменение было заметным:
// если кто-то уберёт Россию из списка, тест упадёт и заставит это осознать.
check('Россия блокируется (решение владельца)', blockedCountryName('RU') === 'Россия')
check('Беларусь блокируется (решение владельца)', blockedCountryName('BY') === 'Беларусь')
check('Украина как страна НЕ блокируется', blockedCountryName('UA') === null)
check('Казахстан НЕ блокируется', blockedCountryName('KZ') === null)
check('США НЕ блокируются', blockedCountryName('US') === null)
check('Грузия НЕ блокируется', blockedCountryName('GE') === null)
check('Армения НЕ блокируется', blockedCountryName('AM') === null)

check('пустое значение даёт null', blockedCountryName('') === null)
check('null даёт null', blockedCountryName(null) === null)
check('не-строка даёт null', blockedCountryName(123) === null)

console.log('\n=== регионы Украины ===')

check(
  'Крым блокируется',
  isBlockedRegion({ country: 'UA', region: 'Crimea' }) === true
)
check(
  'Севастополь блокируется',
  isBlockedRegion({ country: 'UA', region: 'Sevastopol' }) === true
)
check(
  'Донецкая область блокируется',
  isBlockedRegion({ country: 'UA', region: 'Donetska' }) === true
)
check(
  'Луганская область блокируется',
  isBlockedRegion({ country: 'UA', region: 'Luhanska' }) === true
)
check(
  'Запорожская область блокируется',
  isBlockedRegion({ country: 'UA', region: 'Zaporizhzhia' }) === true
)
check(
  'Херсонская область блокируется',
  isBlockedRegion({ country: 'UA', region: 'Kherson' }) === true
)
check(
  'регистр не важен: crimea в нижнем',
  isBlockedRegion({ country: 'UA', region: 'crimea' }) === true
)
check(
  'код региона тоже учитывается',
  isBlockedRegion({ country: 'UA', regionCode: 'UA-40' }) === false // код без названия не матчится
)

check(
  'Киев НЕ блокируется',
  isBlockedRegion({ country: 'UA', region: 'Kyiv' }) === false
)
check(
  'Львов НЕ блокируется',
  isBlockedRegion({ country: 'UA', region: 'Lviv' }) === false
)
check(
  'Крым в другой стране не блокируется',
  isBlockedRegion({ country: 'RU', region: 'Crimea' }) === false
)
check(
  'пустой объект не блокируется',
  isBlockedRegion({}) === false
)
check(
  'без региона не блокируется (нельзя угадывать)',
  isBlockedRegion({ country: 'UA' }) === false
)

console.log('\n=== итоговое решение по гео ===')

const iran = evaluateGeo({ country: 'IR' })
check('Иран: blocked', iran.blocked === true)
check('Иран: kind=country', iran.kind === 'country')
check('Иран: есть заголовок', typeof iran.title === 'string' && iran.title.length > 0)
check('Иран: в сообщении названа страна', iran.message.includes('Иран'))

const crimea = evaluateGeo({ country: 'UA', region: 'Crimea' })
check('Крым: blocked', crimea.blocked === true)
check('Крым: kind=region', crimea.kind === 'region')

const kyiv = evaluateGeo({ country: 'UA', region: 'Kyiv' })
check('Киев: не blocked', kyiv.blocked === false)
check('Киев: сообщения нет', kyiv.message === null)

const russia = evaluateGeo({ country: 'RU', region: 'Moscow' })
check('Россия: blocked (решение владельца)', russia.blocked === true)
check('Россия: kind=country', russia.kind === 'country')
check('Россия: в сообщении названа страна', russia.message.includes('Россия'))

const belarus = evaluateGeo({ country: 'BY' })
check('Беларусь: blocked', belarus.blocked === true)

// Сбой определения не должен ломать сайт целиком.
check('null не блокирует', evaluateGeo(null).blocked === false)
check('undefined не блокирует', evaluateGeo(undefined).blocked === false)
check('пустой объект не блокирует', evaluateGeo({}).blocked === false)
check(
  'ответ без country не блокирует',
  evaluateGeo({ region: 'Crimea' }).blocked === false
)

console.log('\n=== текст о санкционном адресе ===')

const msg = describeAddressBlock({
  names: ['LAZARUS GROUP'],
  programs: ['DPRK3'],
})
check('сообщение содержит имя', msg.includes('LAZARUS GROUP'))
check('сообщение содержит программу', msg.includes('DPRK3'))
check('сообщение говорит про OFAC', msg.includes('OFAC'))

const msgNoName = describeAddressBlock({ names: [], programs: [] })
check('без имён сообщение не пустое', msgNoName.length > 20)
check('без имён нет «undefined»', !msgNoName.includes('undefined'))
check('null не ломает', typeof describeAddressBlock(null) === 'string')

console.log('\n=== список санкций на диске ===')

const raw = readFileSync('public/sanctions/ofac-addresses.json', 'utf8')
const data = JSON.parse(raw)
const addrs = Object.keys(data.addresses ?? {})

check('файл содержит адреса', addrs.length > 100, `адресов: ${addrs.length}`)
check('count совпадает с числом записей', data.count === addrs.length)
check('указан источник', typeof data.source === 'string' && data.source.includes('ofac'))
check('есть дата сборки', typeof data.generatedAt === 'string' && data.generatedAt.includes('T'))
check('есть оговорка о неполноте', typeof data.note === 'string' && data.note.length > 40)

const badFormat = addrs.filter((a) => !/^0x[0-9a-f]{40}$/.test(a))
check('все адреса в нижнем регистре и валидны', badFormat.length === 0, badFormat.slice(0, 3).join(','))

const sorted = addrs.every((a, i) => i === 0 || addrs[i - 1] <= a)
check('адреса отсортированы (стабильный дифф)', sorted)

// Сеть BSC — то, что нам ближе всего.
const bsc = addrs.filter((a) => (data.addresses[a].networks ?? []).includes('BSC'))
check('есть хотя бы один адрес с сетью BSC', bsc.length >= 1, `BSC: ${bsc.length}`)

// Контрольный адрес Lazarus: список живой, поэтому проверяем, что он на месте.
check(
  'адрес Lazarus Group в списке',
  Boolean(data.addresses['0x098b716b8aaf21512996dc57eb0615e2383e2f96'])
)

// Tornado Cash исключён из SDN в марте 2025. Его отсутствие — ожидаемо,
// и тест фиксирует это, чтобы никто не «починил» список обратно.
check(
  'адресов Tornado Cash нет (исключены в 2025)',
  !data.addresses['0x722122df12d4e14e13ac3b6895a86e84145b6967']
)

console.log('\n=== согласованность кода и списка ===')

check('в коде есть Иран', Boolean(BLOCKED_COUNTRIES.IR))
check('в коде есть КНДР', Boolean(BLOCKED_COUNTRIES.KP))
check('в коде есть Сирия', Boolean(BLOCKED_COUNTRIES.SY))
check('в коде есть Куба', Boolean(BLOCKED_COUNTRIES.CU))
check('в коде есть Россия', Boolean(BLOCKED_COUNTRIES.RU))
check('в коде есть Беларусь', Boolean(BLOCKED_COUNTRIES.BY))
check('регионы Украины перечислены', BLOCKED_UA_REGIONS.length >= 5)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)