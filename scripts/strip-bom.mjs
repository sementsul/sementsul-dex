// Убирает BOM из файлов контрактов.
//
// PowerShell при записи через Out-File/Set-Content добавляет BOM, а solc
// считает его частью исходника и падает на первой строке. Проще вычищать
// отдельным шагом, чем помнить об этом при каждой правке.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(ROOT, 'contracts')

let fixed = 0
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sol'))) {
  const path = join(dir, f)
  const buf = readFileSync(path)
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    writeFileSync(path, buf.subarray(3))
    console.log(`BOM убран: ${f}`)
    fixed++
  }
}
console.log(fixed === 0 ? 'BOM не найден' : `исправлено файлов: ${fixed}`)