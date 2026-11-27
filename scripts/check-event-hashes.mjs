// Сверка хэшей событий: подпись из контракта против той, что я использовал.
//
// Поиск позиций опирался на захардкоженный MINT_TOPIC. Если он не совпадает
// с реальной подписью события, я мог декодировать чужие логи — и вывод
// «бот держит позиции в нашем пуле» был бы построен на песке.
//
// Сверяем все три события: Mint, Burn, Collect.
import { keccak256, toHex, parseAbi } from 'viem'
import { readFileSync } from 'node:fs'

// Подписи взяты из contracts/SementsulV3.sol, строки 425-458.
const SIGS = {
  Mint: 'Mint(address,address,int24,int24,uint128,uint256,uint256)',
  Burn: 'Burn(address,int24,int24,uint128,uint256,uint256)',
  Collect: 'Collect(address,address,int24,int24,uint128,uint128)',
}

const USED = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'

for (const [name, sig] of Object.entries(SIGS)) {
  const h = keccak256(toHex(sig))
  console.log(`  ${name.padEnd(8)} ${h}`)
  if (name === 'Mint') {
    console.log(`           ${'использован'.padEnd(8)} ${USED}`)
    console.log(`           ${h === USED ? 'СОВПАДАЕТ' : 'НЕ СОВПАДАЕТ — поиск был неверным!'}`)
  }
}

// Заодно проверим, что каноническая подпись Mint отличается: в Uniswap
// owner не indexed, и порядок другой. Это ловушка при копировании ABI.
const UNI_MINT = 'Mint(address,address,int24,int24,uint128,uint256,uint256)'
console.log('')
console.log('  Наша подпись Mint :', SIGS.Mint)
console.log('  Uniswap V3 Mint   :', UNI_MINT)
console.log('  совпадают:', SIGS.Mint === UNI_MINT ? 'да (различие только в indexed)' : 'нет')
console.log('')
console.log('  indexed в событии не входит в подпись, поэтому хэш у нас и у')
console.log('  Uniswap одинаковый. Различие в том, кто попадает в topic1:')
console.log('  у нас owner indexed и sender нет — значит topic1 = владелец.')