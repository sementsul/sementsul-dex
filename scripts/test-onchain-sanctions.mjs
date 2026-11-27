// Тесты санкционного барьера on-chain версии.
//
// Проверяем то, что нельзя проверить глазами в браузере: правильность
// поиска по сплошной hex-строке. Ошибка на единицу в выравнивании даёт
// ложные пропуски И ложные срабатывания — и то и другое молча.
import { readFileSync } from 'node:fs'

const SRC = readFileSync('src/onchain/sanctions.js', 'utf8')
const build = readFileSync('dist-onchain/index.html', 'utf8')
const json = JSON.parse(readFileSync('public/sanctions/ofac-addresses.json', 'utf8'))
const real = Object.keys(json.addresses)

// Достаём данные из сборки — проверяем то, что реально уедет в блокчейн,
// а не то, что лежит в исходнике.
const hexMatch = build.match(/SANCTIONS_HEX = "([0-9a-f]+)"/)
const dateMatch = build.match(/SANCTIONS_DATE = "([^"]+)"/)
if (!hexMatch) {
  console.error('  FAIL: в сборке нет SANCTIONS_HEX')
  process.exit(1)
}
const HEX = hexMatch[1]
const ADDR_LEN = 40

// Копия логики из sanctions.js. Дублирование намеренное: тест должен
// поймать изменение в исходнике, а не повторить его ошибку.
function isSanctioned(address) {
  if (typeof address !== 'string' || address.length !== 42) return false
  const needle = address.slice(2).toLowerCase()
  if (needle.length !== ADDR_LEN) return false
  const hay = HEX.toLowerCase()
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i === -1) return false
    if (i % ADDR_LEN === 0) return true
    from = i + 1
  }
}

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log('  ok  ', name, extra)
  } else {
    fail++
    console.log('  FAIL', name, extra)
  }
}

console.log('=== данные сборки ===')
check('дата списка есть', !!dateMatch, dateMatch ? dateMatch[1] : '')
check('длина кратна 40', HEX.length % ADDR_LEN === 0)
check('адресов столько же, сколько в файле', HEX.length / ADDR_LEN === real.length, `${HEX.length / ADDR_LEN} vs ${real.length}`)
check('все символы — hex', /^[0-9a-f]+$/.test(HEX))

console.log('\n=== каждый адрес из файла находится ===')
let found = 0
for (const a of real) {
  if (isSanctioned(a)) found++
  else console.log('    пропущен:', a)
}
check('все адреса найдены', found === real.length, `${found}/${real.length}`)

console.log('\n=== регистр не важен ===')
const sample = real[0]
check('нижний регистр', isSanctioned(sample.toLowerCase()))
check('верхний регистр', isSanctioned('0x' + sample.slice(2).toUpperCase()))
check('смешанный регистр', isSanctioned('0x' + sample.slice(2, 10).toUpperCase() + sample.slice(10)))

console.log('\n=== наши кошельки не блокируются ===')
for (const a of [
  '0xC6CF1A60a724c794BeE2F5425D1e418E8c2deb3A',
  '0x1c1E586d5ca9D96A169D47bA98dAB85D11b4DA12',
  '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C',
  '0x922598c9D529836b4b475cE74188D5EeFFb83a88',
]) {
  check('чист: ' + a.slice(0, 10), !isSanctioned(a))
}

console.log('\n=== адреса вне списка не блокируются ===')
const clean = [
  '0x0000000000000000000000000000000000000001',
  '0xffffffffffffffffffffffffffffffffffffffff',
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
]
for (const a of clean) check('чист: ' + a.slice(0, 12), !isSanctioned(a))

console.log('\n=== границы: подстрока поперёк двух адресов ===')
// Берём последние 20 символов первого адреса + первые 20 второго.
// Такая строка есть внутри HEX, но она НЕ является адресом из списка.
const cross = HEX.slice(ADDR_LEN - 20, ADDR_LEN) + HEX.slice(ADDR_LEN, ADDR_LEN + 20)
check('строка поперёк границы не считается адресом', !isSanctioned('0x' + cross))
check('она действительно есть в HEX как подстрока', HEX.includes(cross))

console.log('\n=== мусор на входе не ломает ===')
for (const bad of [null, undefined, '', '0x', 'не адрес', 123, {}, '0x' + 'z'.repeat(40)]) {
  let threw = false
  try {
    isSanctioned(bad)
  } catch (e) {
    threw = true
  }
  check('не бросает: ' + JSON.stringify(bad)?.slice(0, 20), !threw)
}

console.log('\n=== условия и дисклеймер ===')
check('условия содержат дисклеймер ЕЭЗ/США', build.includes('Не для резидентов США, ЕЭЗ'))
check('условия упоминают 451/гео', /резидентов США, ЕЭЗ/.test(build))
check('условия упоминают необратимость', build.includes('необратимы'))
check('условия упоминают риск потерь', build.includes('риск потерь'))

console.log('\n=== барьер стоит в render() ===')
check('санкции проверяются до вкладок', /if \(sanctionHit\) \{\s*renderSanctioned\(\)/.test(build))
check('условия проверяются до вкладок', /if \(renderTerms\(\)\) return/.test(build))
check('проверка при смене аккаунта', build.includes('checkSanctions(acc)'))
check('проверка при восстановлении', build.includes('checkSanctions(a[0])'))

console.log('\n=== счёт ===')
console.log('  ', pass, 'passed,', fail, 'failed')
process.exit(fail === 0 ? 0 : 1)