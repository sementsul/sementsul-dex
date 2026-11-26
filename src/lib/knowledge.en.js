// English translation of the knowledge base.
// Mirrors ARTICLES from knowledge.js one-to-one: same ids, same order,
// same number of sections and paragraphs. A test asserts this stays true.
//
// There is no marketing here. The point of the section is that a person adding
// liquidity for the first time understands the risk before signing, not after.
// So the articles are about concrete things: where income comes from, why a
// loss happens, what an arbitrageur does and why that is not evil.

export const ARTICLES_EN = [
  {
    id: 'tvl',
    title: 'What TVL is and why it matters',
    summary: 'How much money sits in a pool, and why slippage depends on it.',
    tags: ['Basics'],
    body: [
      {
        h: 'Definition',
        p: [
          'TVL (Total Value Locked) is the total value of the tokens locked in a pool. It is calculated simply: take both reserves, convert each one to dollars and add them up.',
          'If a pool holds 10 BNB and 7,000 USDT and BNB costs 700 dollars, then TVL = 10 × 700 + 7,000 = 14,000 dollars.',
        ],
      },
      {
        h: 'Why it matters more than the fee',
        p: [
          'The fee determines how much you earn from each swap. TVL determines how much you earn from all swaps together — and how expensive a swap is for the person trading.',
          'The price shift when buying an amount A in a pool with reserve R is (1 + A/R)² − 1. If a pool has a TVL of 1,000 dollars (500 on each side), a purchase of 100 dollars will move the price by 44%. In a pool with a TVL of 100,000 (50,000 on each side) the same purchase moves it by 0.4%. Hence the rule: large swaps go where there is more money — and the fees follow.',
        ],
      },
      {
        h: 'Why TVL can be a dash',
        p: [
          'To calculate TVL in dollars you need the token price in a dollar unit. If the pool holds no USDT and the token has no pool with USDT, there is nowhere to get a reliable price.',
          'In that case the interface shows a dash, not a zero. Zero would mean "there is nothing in the pool", which is not true; a dash means "we do not know the value" — and that is honest.',
        ],
      },
      {
        h: 'What TVL does not show',
        p: [
          'TVL does not say how much money the providers earned. A pool with a large TVL and sluggish trading brings in less than a small pool with active trading.',
          'A more important indicator than TVL is the daily trading volume — but ours will appear once enough swap history has accumulated.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'impermanent-loss',
    title: 'Impermanent loss: where a provider\'s loss comes from',
    summary: 'Why an LP can lose money even when the price comes back to where it was.',
    tags: ['Risks', 'V2'],
    body: [
      {
        h: 'The gist',
        p: [
          'A pool always keeps the product of its reserves constant: x × y = k. When the price of one token rises, the pool automatically sells it — and keeps selling a little all the way up. When the price falls, it buys.',
          'The liquidity provider ends up in a position opposite to the move: it sold on the way up and bought on the way down. If it had simply held the tokens, it would have more.',
        ],
      },
      {
        h: 'The formula and the numbers',
        p: [
          'The loss relative to simply holding is calculated as: IL = 2 × √r / (1 + r) − 1, where r is how many times the price changed.',
          'If the price doubles: IL = 2 × √2 / 3 − 1 ≈ −5.7%. If it rises fivefold: ≈ −25.5%. If it falls by half — the same −5.7%, because the formula is symmetric.',
        ],
      },
      {
        h: 'What to do about it',
        p: [
          'Fees are compensation for impermanent loss. If the pair trades actively, the fees cover the IL; if it stands still, they do not.',
          'Choose pairs where you expect price movement in both directions and active trading. A pair that rises in one direction without pullbacks is the worst case for an LP.',
        ],
      },
      {
        h: 'An important distinction',
        p: [
          'IL is not a loss in dollars as such, but falling behind the alternative of "just holding". If the token went up, you are still in profit — just less than you could have been.',
          'A real loss occurs when the IL is greater than the accumulated fees. That happens in quiet pools and during sharp one-sided moves.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'v2-vs-v3',
    title: 'V2 and V3: the difference in practice',
    summary: 'The plain pool and the concentrated one: which one suits whom.',
    tags: ['Basics', 'V3'],
    body: [
      {
        h: 'V2: the whole price in one place',
        p: [
          'Liquidity is spread across the entire price scale from zero to infinity. Simple: you deposit two coins, you get an LP token and a share of the pool.',
          'The downside is that capital works inefficiently. Most of the money sits where the price will never be, and earns nothing.',
        ],
      },
      {
        h: 'V3: liquidity within a range',
        p: [
          'You choose the corridor of prices in which your capital works. Money inside a narrow corridor earns far more fees for the same amount.',
          'The price for that is control. If the price leaves the corridor, the position stops earning and turns into a single token: on a break upward — into the second one, on a break downward — into the first.',
        ],
      },
      {
        h: 'A comparison in numbers',
        p: [
          'With the same capital, a narrow range provides more liquidity at the point of trade, and therefore more fees. The gain is roughly this: ±2% — 100x, ±5% — 40x, ±10% — 20x, ±50% — 4x against a plain pool.',
          'This is not profit but concentration: the same multiplier applies to risk as well. A ±2% position breaks down when the price moves by 2%, and then the earning stops.',
        ],
      },
      {
        h: 'What to choose',
        p: [
          'V2 — if you do not want to watch the price and are prepared for a modest yield. Suited to pairs with wide movement.',
          'V3 — if you are prepared to move the range from time to time and understand that the position can "go out". Suited to stable pairs such as stablecoin/stablecoin.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'arbitrage',
    title: 'Arbitrageurs: why the exchange needs them',
    summary: 'Who levels the price, and why that does not harm providers.',
    tags: ['Mechanics'],
    body: [
      {
        h: 'What they do',
        p: [
          'The price in a pool changes only through swaps. If a token costs more on other exchanges than in our pool, someone will buy here and sell there — and the price will catch up.',
          'That is arbitrage. It does not parasitize the pool, it keeps the price in line with the market: without it the pool would live its own life and drift away from reality.',
        ],
      },
      {
        h: 'Why it benefits providers',
        p: [
          'An arbitrageur pays the same fee as everyone else. Every swap it makes brings income into the pool.',
          'The worse thing is the absence of arbitrage. A pool whose price is detached from the market becomes a source of cheap tokens for anyone who wants them, and bots are the first to take advantage of that.',
        ],
      },
      {
        h: 'What a provider should be afraid of',
        p: [
          'Not arbitrage, but a sharp one-sided move: when the price goes one way quickly and for a long time, the LP takes losses and the fees do not have time to cover them.',
          'The second thing is "sandwich" attacks on large swaps. We send transactions through a private RPC so that such attacks are harder to build.',
        ],
      },
      {
        h: 'The sandwich: why it cannot be banned in the contract',
        p: [
          'The temptation is understandable: spot "buy — someone\'s trade — sell" in a block and forbid it. The trouble is that the pool contract does not distinguish an attack from ordinary activity.',
          'The same set of operations is produced by an arbitrageur leveling the price across several pools at once, and by a user who simply changed their mind. The difference is visible only from outside — from what happened in other pools and in other transactions of the block. The pool does not see that.',
          'Verified: the rule "forbid a round trip from one address within a block" breaks routers. Everyone goes through a router, and for the pool that is a single address — so two trades by different people in a row look like one round trip.',
        ],
      },
      {
        h: 'What actually protects you',
        p: [
          'Your own slippage limit. It is the only protection that always works: the trade simply will not go through if the price turned out worse than you agreed to.',
          'Private transaction submission: if your trade is not visible in the open queue, there is nothing to reorder.',
          'That is why in the interface the slippage limit is not hidden under "advanced settings" but placed in plain sight, and transactions go through a private RPC.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'router-v3',
    title: 'The V3 router: why it is needed',
    summary: 'The path a trade takes into a concentrated pool.',
    tags: ['Mechanics', 'V3'],
    body: [
      {
        h: 'A pool can do only one step',
        p: [
          'The pool contract performs exactly one swap in one direction. Everything else — "give exactly this much", "receive exactly this much", "route through two pools" — is a layer on top.',
          'The router is that layer. It knows the order of the calls, it can assemble a route and it can settle the payment.',
        ],
      },
      {
        h: 'How payment happens',
        p: [
          'If a swap is started by an ordinary wallet, the pool debits the money directly — as always. A wallet cannot answer requests, and there is nothing to demand from it.',
          'If a swap is started by a contract, the pool first sends the output, and then asks for payment in a callback. This is needed for routes across several pools: at the first step the contract has no money yet, it appears only after the first pool has returned its output.',
          'That is exactly why our pools used to be invisible to aggregators: they only know how to pay this way, and not "hand over an approval in advance for an amount you do not have".',
        ],
      },
      {
        h: 'What it gives',
        p: [
          'Our interface can finally trade in V3 pools — before that there was simply nowhere to send the route.',
          'External aggregators and arbitrage bots get the execution path they are used to. Without that, liquidity by itself does not bring traffic.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'fees',
    title: 'Fees and who receives them',
    summary: 'Where the provider\'s income comes from, and why the protocol takes no share of it.',
    tags: ['Basics'],
    body: [
      {
        h: 'The rate and the tiers',
        p: [
          'The fee is set by the factory when the pool is created and cannot be changed by the pool creator. That is a protection: otherwise the pool owner would set 99% and rob the providers.',
          'Our rates are recorded in units of one millionth: 2500 is 0.25%, 500 is 0.05%, 50 is 0.005%.',
          'There is not one rate but four — this is called tiers. For a single pair you can create one pool per tier: they have different addresses, and liquidity does not mix between them. Trading goes to the pool where it is cheaper.',
          'Why several: for a pair with a stablecoin the price barely moves, and 0.005% is enough for the provider; for an exotic token the price jumps, and 1% is the price of risk. A single common tier would force everyone to pay for the worst case.',
        ],
      },
      {
        h: 'Distribution',
        p: [
          'The whole fee stays in the pool and is distributed among the providers in proportion to their share. There is no share going "upstairs" at all.',
          'The protocol takes no share. There is no protocol-fee mechanism in the contracts and no switch to enable one in the future: the whole fee stays with liquidity providers.',
        ],
      },
      {
        h: 'How to calculate income',
        p: [
          'Provider income ≈ trading volume for the period × fee rate × your share of the pool.',
          'If 50,000 dollars passed through the pool in a day at a rate of 0.25%, the providers together received 125 dollars. Your share is the same as your share of the pool.',
        ],
      },
      {
        h: 'JIT bots and why the fee vests',
        p: [
          'JIT (just-in-time) is a bot that pours a large amount of liquidity in one block before someone else\'s swap and removes it right after. The fee is split in proportion to liquidity at the moment of the swap, so the bot takes almost everything without risking anything: it does not hold the position while the price moves.',
          'Our measurement: with a bot ten times larger than an honest provider, it gets 90.9% of the fee. The rate has nothing to do with it — the share depends only on the ratio of the sizes, so lowering the fee does not protect against JIT.',
          'The protection: the accrued fee is not paid out instantly but vests for a set number of blocks. If liquidity is removed before the term, a part of the vesting fee proportional to the amount removed is burned. A bot that removes everything at once gets nothing.',
          'The vesting period depends on the tier: the higher the rate, the longer. At 0.005% it is about 250 blocks (two minutes), at 0.05% about 1150 (eight minutes), at 0.25% about 5150 (thirty-eight minutes), at 1% about 20,150 (two and a half hours). The point: the bot\'s profit is proportional to the rate, while the risk of holding grows with time, so at a fat rate waiting has to be expensive.',
          'The honesty boundary: a bot willing to wait will still take the fee. The protection kills the "in and out in one block" scheme, but does not make JIT impossible — it makes it unprofitable to the extent the economics allow.',
          'An honest provider loses nothing: it holds the position for a long time anyway, and the vested fee arrives in full after the term. The only inconvenience is that the fee cannot be taken in the same second it accrues.',
          'The boundary of the protection is honest and worth knowing: a bot can wait out the term and still take the fee. But to do that it has to keep liquidity in the pool while the price moves — that is, carry the very risk the provider exists for. What was "in and out" turns into ordinary participation in the pool with extra waiting.',
        ],
      },
      {
        h: 'When income is deceptive',
        p: [
          'A high rate attracts arbitrageurs and scares off ordinary traders, who go where it is cheaper. As a result volume falls, and "volume × rate" can turn out smaller than at a low rate.',
          'That is exactly why low rates are not charity but a way to win the competition for volume.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'create-pool',
    title: 'How to create a pool',
    summary: 'Step by step: from choosing tokens to the first price.',
    tags: ['Guides'],
    body: [
      {
        h: 'Who can',
        p: [
          'Anyone. There are no permissions, no applications, no approval either. A pool is a contract created by your transaction.',
          'The only restriction is that the pair must not already exist: two pools for one pair would split the liquidity.',
        ],
      },
      {
        h: 'Steps',
        p: [
          '1. Open "Pools" → "Create pool".',
          '2. Choose two tokens. Native BNB is automatically replaced with WBNB — a pool cannot hold ordinary BNB.',
          '3. Choose the type: V2 (plain) or V3 (concentrated).',
          '4. Confirm the transaction. Gas is a small amount in BNB.',
          '5. Add liquidity. An empty pool is useless: without money in it nobody can trade.',
        ],
      },
      {
        h: 'The first price',
        p: [
          'An empty pool has no price — the first provider sets it by the ratio of the amounts. This is the most critical moment: if you set the price below the market, arbitrageurs will immediately buy up the difference at your expense.',
          'For V3 the price is set by a separate call and only once. It cannot be canceled or changed.',
        ],
      },
      {
        h: 'What is worth understanding',
        p: [
          'Creating a pool costs nothing but gas, but it also brings nothing by itself. Income appears only when the pool has liquidity and swaps go through it.',
          'An empty pool is marked as "empty" in the list — that is not an error but a state.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'liquidity',
    title: 'Adding and withdrawing liquidity',
    summary: 'What happens to the money when you enter and exit.',
    tags: ['Guides'],
    body: [
      {
        h: 'V2: a share of the pool',
        p: [
          'You deposit two coins in the proportion that already exists in the pool. In return you receive LP tokens — ordinary tokens that can be transferred or sold.',
          'Your share of the pool equals your LP tokens divided by their total amount. Fees accrue by themselves: they simply stay in the reserves, and your share grows in value.',
        ],
      },
      {
        h: 'V2: withdrawal',
        p: [
          'You burn the LP tokens — and get both coins back in the current proportion. Not the one you deposited: while you were participating, the price could have changed, and that is impermanent loss.',
        ],
      },
      {
        h: 'V3: a position within a range',
        p: [
          'You choose a price corridor and deposit an amount. A position is a separate object with its own range; there can be several of them in one pool.',
          'While the price is inside the corridor, the position earns fees. When it goes beyond the boundary, it stops, and the whole position ends up in a single token.',
        ],
      },
      {
        h: 'V3: withdrawal',
        p: [
          'Withdrawal is two transactions: remove the liquidity and collect the tokens with the fees. If you do only the first, the tokens remain in the contract and are available to you, but not on your balance.',
          'To withdraw a position you need to know its range in ticks: the contract stores positions by a key of owner and range, but cannot list them.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'risks',
    title: 'Risks: the full list',
    summary: 'What can go wrong, without softening the wording.',
    tags: ['Risks'],
    body: [
      {
        h: 'Market',
        p: [
          'Impermanent loss — falling behind simply holding when the price moves.',
          'A one-sided move — the price leaves, the V3 position goes out, the fees stop.',
          'A token collapse — the reserve falls in value, and no fee compensates for that.',
        ],
      },
      {
        h: 'Technical',
        p: [
          'A bug in the contract. Our contracts are covered by tests, but tests do not prove the absence of bugs.',
          'A bug in the interface — for example, a wrongly calculated amount. That is why the interface shows the calculation before signing, and you can check it in the wallet.',
          'Network congestion or overload — the transaction may not go through or may get stuck.',
        ],
      },
      {
        h: 'Token-related',
        p: [
          'A token with a transfer fee — the pool receives less than it expects, and the calculations diverge.',
          'A token with freezing or a blacklist — your funds may end up frozen through no fault of ours.',
          'A fake token with the same symbol. Check the address, not the name: anyone can write any symbol.',
        ],
      },
      {
        h: 'What we do not do',
        p: [
          'We do not promise yield. Income depends on trading volume, which we do not control.',
          'We do not insure losses. If the price moved, that is the market, not a failure.',
          'We do not moderate pools. Anyone can create a pool with any token, including a fraudulent one.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'security',
    title: 'How we protect funds',
    summary: 'What has been done so that the contracts cannot be robbed.',
    tags: ['Security'],
    body: [
      {
        h: 'No owner over the tokens',
        p: [
          'The exchange does not issue its own tokens and does not manage anything in anyone else\'s. The test token that was shown here earlier has been taken off the site and no longer appears in the interface.',
          'The exchange\'s own contracts do not use delegatecall and selfdestruct — the code does not change after deployment.',
        ],
      },
      {
        h: 'The factory does not substitute pools',
        p: [
          'The router does not trust the address it is handed. It computes the pair address through the factory and checks that the pair really was created by it. You cannot slip in a fake contract that will "hand over" the liquidity.',
          'The fee is set by the factory, not by the pool creator: it cannot be tweaked in your favor after creation.',
        ],
      },
      {
        h: 'Private submission',
        p: [
          'Transactions go out through a private RPC that does not show them in the public mempool before inclusion in a block. This makes frontrunning and "sandwich" attacks harder.',
          'This is not a guarantee: privacy reduces the likelihood of an attack but does not make it impossible.',
        ],
      },
      {
        h: 'What remains with you',
        p: [
          'Checking the token address before buying. Symbols are faked.',
          'Checking the amounts and the recipient address in the wallet window — that is where the final version of the transaction is.',
          'Not putting into pools money whose loss you would not survive.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'api',
    title: 'API: how to get exchange data',
    summary: 'Four endpoints that return candles, trades and statistics as JSON.',
    tags: ['Basics', 'Guides'],
    body: [
      {
        h: 'What this API is',
        p: [
          'The API returns the history of swaps that have passed through our pools. It exists so that you can build charts, calculate volumes or connect a bot — without reading the blockchain from scratch.',
          'Base address: https://api.sementsul.net. All responses are JSON, no version is needed, no key is needed. Requests are read-only: you cannot send a transaction or change anything through the API.',
        ],
      },
      {
        h: 'Where the data comes from',
        p: [
          'Swap events are read from the blockchain by a separate scheduled job and stored in a database. The worker that answers requests does not read the blockchain at all — it serves what is already in the database.',
          'This separation is not an oversight. Public BNB Chain nodes do not serve historical events to requests from the cloud: they see a single shared address and turn on rate limiting. And parsing a block as a whole runs into the CPU-time limit of the free tier. That is why the heavy work is taken outside, and the API has stayed cheap.',
          'The practical consequence: the data lags behind the chain. Usually by minutes, and more if the job fails. For a chart that is unnoticeable; for arbitrage it is unsuitable — there the price is read straight from the pool.',
        ],
      },
      {
        h: 'The four endpoints',
        p: [
          'GET /api/health — a connectivity check. Returns {ok: true, ts}, where ts is the response time in milliseconds. If this address answers, the service is alive.',
          'GET /api/stats?pair=0x... — a summary for the pair: the latest price, the time of the last trade, the daily turnover, how many trades in total have been indexed and up to which block.',
          'GET /api/trades?pair=0x...&limit=20 — the latest trades as a list: transaction hash, block, time, protocol, direction, amounts and price. limit defaults to 20, maximum 200.',
          'GET /api/candles?pair=0x...&interval=1h&limit=200 — candles for the chart. interval accepts 5m, 15m, 1h, 4h, 1d. limit defaults to 200, maximum 1000.',
        ],
      },
      {
        h: 'The pair parameter',
        p: [
          'This is the address of the pool, not of the token. One token can trade in several pools, and each has its own history — so you have to ask for a specific pool.',
          'For example, our USDT/WBNB pool: /api/stats?pair=0x37c7702B589c69D1e4f4ad32E19f372ED6780278.',
          'If pair is not specified, a default pair is substituted. Do not rely on that: the value can change, and the request will silently start returning someone else\'s history.',
        ],
      },
      {
        h: 'What comes in the candles',
        p: [
          'Each candle is time, open, high, low, close, trades and volume. volume is the sum of the input amounts of the trades over the interval; trades is how many trades fell into it.',
          'Candles come from newest to oldest, not the other way round. It is worth checking this before drawing: most chart libraries expect ascending order, and a reversed array gives an empty chart with not a single error in the console.',
          'The price in the candles is the price of token1 per token0, not "dollars per token". For the USDT/WBNB pair it means "how much WBNB for 1 USDT", so the usual price is obtained by inverting. The direction is set by the order of the addresses in the pool, not by how you named the pair.',
        ],
      },
      {
        h: 'Flash swaps do not enter the price',
        p: [
          'In the database a trade has a kind: a normal swap or a flash swap. A flash swap is a loan inside a single transaction where the tokens are returned in the same block; its "price" does not reflect the market and is often zero.',
          'Such records are stored, but they do not go into the candles or the volume. Otherwise a single flash swap would zero out the candle low, and the chart would show a drop that never happened.',
        ],
      },
      {
        h: 'Errors',
        p: [
          'An unknown interval gives a 400 response and the list of allowed values in the allowed field. A non-existent address gives 404. A server error gives 500 with text in the error field.',
          'An empty result is not an error. If there have been no trades for the pair yet, you get zeros and empty arrays with a 200 response. That is how it should be: an empty history is different from a failure, and the client does not have to guess what it is looking at.',
        ],
      },
      {
        h: 'Limitations',
        p: [
          'CORS is open: you can call it straight from the browser from any site. There is no authorization, no keys.',
          'The service runs on a free tier, so it has a daily request limit and a database read limit. Under active use it can run out before the end of the day — then the API will start answering with an error instead of silently returning emptiness.',
          'If you need data constantly and in large amounts, it is more reliable to read the blockchain yourself: the pool returns the current price and liquidity by a direct call, and no one\'s limit affects that.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'mev',
    title: 'MEV: how other people\'s bots profit from your trade',
    summary: 'What happens between pressing "swap" and inclusion in a block.',
    tags: ['Risks', 'Security'],
    body: [
      {
        h: 'What MEV is',
        p: [
          'MEV stands for maximal extractable value. It is money you can get not by trading, but by knowing which transactions are about to go into a block and by having the right to reorder them.',
          'In an ordinary bank a transfer cannot be reordered: it either went through or it did not. In a blockchain, before inclusion in a block, transactions sit in an open queue, and whoever assembles the block decides in what order to put them. That is what is exploited.',
        ],
      },
      {
        h: 'The sandwich: the most common scheme',
        p: [
          'You send a purchase of a token. The bot sees it in the queue and puts its own purchase in front of you — the price shifts up. Then your trade goes through, already at a worse price. Then the bot sells what it bought and pockets the difference.',
          'You did not notice the deception: the trade went through, the tokens arrived, the interface showed success. The price was simply a little worse, and the difference went to the bot. On a large amount that is percents, on a small one cents, which is why the scheme is mass-scale: bots work on volume.',
          'There is exactly one protection here and it works: the slippage limit. If you allowed 0.5% slippage, a shift of more than 0.5% simply will not let the trade go through. The bot knows that and usually does not bother: its profit is less than the risk of not executing.',
        ],
      },
      {
        h: 'What we do',
        p: [
          'Transactions go out through a private RPC. Such submission passes the signed transaction directly to whoever assembles the block, bypassing the public queue. The transaction cannot be seen in advance, so there is nothing to reorder.',
          'This is not a guarantee. A private channel reduces the likelihood of an attack but does not make it impossible: part of the flow still passes through assemblers that look at the contents. Promising "we have removed MEV" would be a lie.',
          'What really is on your side: the slippage limit is placed in plain sight, not hidden in settings. It remains the last line, and it works regardless of how the transaction was sent.',
        ],
      },
      {
        h: 'The other side: arbitrage is not evil',
        p: [
          'The same mechanism a sandwich bot uses levels the price between pools. If a token has become more expensive in our pool than in a neighboring one, an arbitrageur will sell it here and buy it there — the price levels out.',
          'Without that the price in the pool would drift away from the market and stay that way until someone gathered the strength. For a liquidity provider, arbitrage is what keeps the pool in the market, and its fee also goes to the pool.',
          'So the task is not "destroy all bots" but make it so that an honest trade does not suffer from having been seen.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'jit',
    title: 'JIT liquidity: the fee taken away within one block',
    summary: 'Why a V3 fee may not go to you, and what has been done about it.',
    tags: ['Risks', 'V3', 'Security'],
    body: [
      {
        h: 'The scheme in one block',
        p: [
          'In V3 liquidity can be added to a narrow range and removed back. A JIT (just-in-time) bot does this inside a single block: it sees a large swap in the queue, places its own dense liquidity in front of it exactly in the range where the trade will pass, takes the fee from that swap and exits.',
          'All of it is one transaction or several in a row within one block. To the pool it looks like ordinary mint and burn. For an honest liquidity provider it means the fee from a large trade went to someone else, even though its money had been lying in the pool all that time and carrying risk.',
        ],
      },
      {
        h: 'Why it is possible',
        p: [
          'In the classic V3 model the fee accrues instantly and can be taken immediately. If it can be taken immediately, you can also enter for one block: the risk during that time is almost zero, and the fee from a large swap is quite tangible.',
          'The economics of the scheme rest on that: the profit is immediate, the risk is almost nil. Remove the immediacy — and the scheme stops paying for itself.',
        ],
      },
      {
        h: 'What has been done here: fee vesting',
        p: [
          'The fee accrued to a position does not land in the available balance at once. It sits separately and becomes available only after a set number of blocks — its own for each fee tier: 250 blocks at 0.005%, 1150 at 0.05%, 5150 at 0.25%, 20150 at 1%.',
          'All that time the fee is unavailable: it cannot be taken without removing liquidity. And if liquidity is removed before the term, a proportionate share of the still-locked fee burns along with it. Removed 100% — lost all that was in vesting.',
          'For a JIT bot this changes the arithmetic: to take the fee it has to stay in the pool for the whole vesting period and carry price risk. In a narrow range that risk is exactly what eats the profit — especially at 1%, where you wait 20150 blocks, that is about two and a half hours.',
        ],
      },
      {
        h: 'Why the delay grows as the square of the rate',
        p: [
          'The profit of the bot is proportional to the fee rate: at 1% the same volume drips twenty times more than at 0.05%. The risk of holding grows as the square root of time. Equating the one to the other gives a break-even time proportional to the square of the rate.',
          'Hence the different delays per tier. If the same one applied to all tiers, the protection would be real only at small rates, and at 1% there would be none at all.',
        ],
      },
      {
        h: 'What this does not do',
        p: [
          'This is not "eradication" of JIT. We cannot forbid someone to add and remove liquidity — it is a legitimate operation, and ordinary providers need it. We can only make the scheme unprofitable. How much — depends on volatility: in a calm market even a long delay costs almost nothing.',
          'Vesting is not free for an honest provider either: the fee also arrives with a delay. We consider that an acceptable price and keep the delay at the lower boundary where the scheme is already unprofitable.',
          'Separately: the delay is set by the factory, not by the pool creator. It cannot be tweaked in your favor after the pool is created.',
        ],
      },
    ],
    sources: [],
  },

  {
    id: 'contracts',
    title: 'Exchange contracts: addresses and what you can do with them',
    summary: 'The full list of what is deployed, with links to the block explorer.',
    tags: ['Basics', 'Guides'],
    body: [
      {
        h: 'How to use this',
        p: [
          'All the addresses below are on the BNB Smart Chain network, chainId 56. Tokens and liquidity sent to another network will be lost: these contracts do not exist there.',
          'Every contract is verified in the block explorer, meaning the source code is published and matches what is executed. You can and should check this yourself — the link leads to the contract page, and the "Contract" tab shows the code.',
          'The address of any pool can be copied in the interface: on the pools page and in the pool card there is a copy button next to the address. Do not type an address by hand — an error in a single character will send the money to the wrong place.',
        ],
      },
      {
        h: 'The core of the exchange',
        p: [
          'V2 factory — 0x6f950C2212754f54Cf4e99EBA6c3F699725B89b6. Creates pairs and stores the list of all pairs. It has no owner and no fee switch: the 0.25% rate is fixed in the code.',
          'V2 router — 0x2069336bD5E70c4F359Ff4142a8B072D074cbbe6. Swaps, adding and withdrawing liquidity in V2 pairs go through it. It does not trust the pair address but recomputes it through the factory.',
          'V3 factory — 0xc0b597bee57bba0aae2ce9e73e83217331a24dd9. Creates concentrated pools in four fee tiers and stores the JIT protection delays.',
          'V3 router — 0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1. Swaps and work with positions in V3 pools.',
        ],
      },
      {
        h: 'Our pools',
        p: [
          'USDT / WBNB, V3 — 0x37c7702B589c69D1e4f4ad32E19f372ED6780278. Tier 0.05%, tick spacing 10. The price at creation was taken from the deepest Pancake pool, so the pool opened at the market rather than at an assigned rate.',
          'The previous pool for the same pair — 0x3688726E5811E766A0cA014dCEC24622c0d02583. Its code had a defect: the first entry into a new tick range in a pool where fees had already accumulated recorded a wrong fee snapshot for the position, and the position stopped responding to withdrawal. The defect is fixed and the pool was recreated; the old one is left only so that the history and one locked position can be seen. There is no need to use it.',
          'Pools are created via create2, so a pool address can be computed in advance — before the creation transaction. The factory returns it with the poolFor method for V3 and getPair for V2.',
        ],
      },
      {
        h: 'Why the pools are not in this list',
        p: [
          'A pool is created at the moment someone first adds liquidity to a new pair. They cannot be listed in advance: they do not exist until they are created.',
          'That is why the list of pools is taken not from here but from the pools page — it reads the factory and shows everything that has been created. Here we list only what is deployed once and for all.',
        ],
      },
      {
        h: 'What is worth checking yourself',
        p: [
          'That the token address matches the one on this page. A symbol is easy to fake, an address is not. A fake token with the same symbol can end up in the list next to the real one.',
          'What you are signing in the wallet. The wallet window shows the final version of the transaction: the amount, the recipient address, the contract. It is the last point where you can stop.',
          'That the network is BNB Smart Chain. The wallet may be switched to another network, and then the transaction will go to the wrong place.',
        ],
      },
    ],
    sources: [],
  },
]
// Поиск по английской базе знаний. Отдельная функция, а не параметр языка в
// searchArticles: русский и английский тексты ищутся в своих массивах, и
// смешивать их в одной функции значило бы однажды перепутать массивы.
export function searchArticlesEn(query) {
  const q = query.trim().toLowerCase()
  if (!q) return ARTICLES_EN

  return ARTICLES_EN.filter((a) => {
    const hay = [
      a.title,
      a.summary,
      ...a.tags,
      ...a.body.flatMap((s) => [s.h, ...s.p]),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}

export function getArticleEn(id) {
  return ARTICLES_EN.find((a) => a.id === id) || null
}
