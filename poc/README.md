# Virtual-reserve settlement PoC

`virtual_reserve_settlement_poc.py` is a dependency-free, read-only screening
harness for the strongest audit hypothesis in this repository.

It reads a PumpSwap `Pool`, its base/quote vaults, and its mints in a batched
RPC request. It then compares:

```text
pricing quote = raw quote vault + virtual_quote_reserves
settlement cap = raw quote vault
```

Run the deterministic checks first:

```bash
python3 poc/virtual_reserve_settlement_poc.py --self-test
```

Run against the documented mainnet pool:

```bash
python3 poc/virtual_reserve_settlement_poc.py \
  --pool GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J
```

To screen a larger sell amount:

```bash
python3 poc/virtual_reserve_settlement_poc.py \
  --pool <POOL> \
  --sell-base-in 1000000000 \
  --fee-bps 25
```

## Interpretation

- `NO_SCREENED_ANOMALY`: the selected quote fits inside the real quote vault.
- `CANDIDATE_REQUIRES_TRANSACTION_POC`: effective-reserve pricing exceeds
  real-vault liquidity; the deployed instruction must reject or cap it.
- `INVARIANT_VIOLATION`: the observed account state violates a basic invariant.

The PoC does not sign, simulate, or submit a transaction. A
`CANDIDATE_REQUIRES_TRANSACTION_POC` result is not a confirmed vulnerability:
the next step is to reproduce the exact quote and settlement path with the
official PumpSwap SDK on a disposable devnet fixture.

## Devnet transaction fixture

`devnet-virtual-reserve-fixture.ts` uses the official
`@pump-fun/pump-swap-sdk`. It creates a fresh Token-2022/WSOL pool, initializes
boost, calls `boost_buy_and_burn`, and then builds a sell with
`min_quote_amount_out = 0` so the deployed program—not only the SDK quote
helper—handles the real-vault constraint.

Install its isolated dependencies:

```bash
cd poc
npm install
```

Set `ANCHOR_WALLET` to a funded devnet creator keypair and
`BOOST_AUTHORITY_KEYPAIR` to the keypair matching devnet
`GlobalConfig.boostAuthority`. The script never accepts a non-devnet
`RPC_URL`.

Dry-run configuration:

```bash
npm run devnet-fixture
```

Actually create the disposable pool and send devnet transactions:

```bash
npm run devnet-fixture -- --execute
```

`--execute` is intentionally required. The fixture mutates only devnet
accounts, and it does not use or request a mainnet key.