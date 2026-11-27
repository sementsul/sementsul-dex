// Балансы всех наших адресов: кто может заплатить газ за снятие.
import { createPublicClient, http, formatEther, formatUnits, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

const WALLETS = [
  ['получатель (наш пул)', '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'],
  ['бот', '0x922598c9D529836b4b475cE74188D5EeFFb83a88'],
  ['зеркало', '0xC6CF1A60a724c794BeE2F5425D1e418E8c2deb3A'],
]

const gasPrice = await client.getGasPrice()
console.log('  gasPrice:', gasPrice / 1_000_000_000n, 'gwei')
console.log('')

for (const [label, addr] of WALLETS) {
  const [bnb, u, w] = await Promise.all([
    client.getBalance({ address: addr }),
    client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [addr] }),
    client.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [addr] }),
  ])
  console.log(`  ${label} (${addr.slice(0, 10)}…)`)
  console.log(`    BNB  : ${formatEther(bnb)}`)
  console.log(`    USDT : ${formatUnits(u, 18)}`)
  console.log(`    WBNB : ${formatUnits(w, 18)}`)
  console.log('')
}