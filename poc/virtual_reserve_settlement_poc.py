#!/usr/bin/env python3
"""Read-only PumpSwap virtual-reserve settlement PoC.

This is a screening harness, not an exploit and not a transaction sender.
It reads one Pool plus its token accounts from Solana RPC, applies the
documented effective-quote-reserve model, and checks whether a constant-product
sell quote can exceed the real quote vault.

The important distinction is:

    pricing_quote = raw_quote_vault + virtual_quote_reserves
    settlement_cap = raw_quote_vault

If pricing_quote produces an output above settlement_cap, that is an expected
condition covered by the documented InsufficientRealQuoteReserves behavior. It
is only evidence of a bug if a deployed transaction can settle above the cap,
or if the cap lets an attacker extract more than the pool's real assets.

No private key, signer, transaction, or write RPC method is used.

Example:

    python3 poc/virtual_reserve_settlement_poc.py \
      --pool GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J

Synthetic test:

    python3 poc/virtual_reserve_settlement_poc.py --self-test
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple


DEFAULT_RPC = "https://api.mainnet-beta.solana.com"
PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

# Anchor account layout documented by pump-public-docs.
DISCRIMINATOR_LEN = 8
POOL_BASE_MINT_OFFSET = 43
POOL_QUOTE_MINT_OFFSET = 75
POOL_LP_MINT_OFFSET = 107
POOL_BASE_VAULT_OFFSET = 139
POOL_QUOTE_VAULT_OFFSET = 171
POOL_LP_SUPPLY_OFFSET = 203
POOL_VIRTUAL_QUOTE_OFFSET = 245
POOL_MIN_SIZE = POOL_VIRTUAL_QUOTE_OFFSET + 16


class PocError(RuntimeError):
    """A malformed or unavailable RPC/account state."""


def ceil_div(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    return (numerator + denominator - 1) // denominator


def decode_base58(raw: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    value = int.from_bytes(raw, "big")
    encoded = ""
    while value:
        value, remainder = divmod(value, 58)
        encoded = alphabet[remainder] + encoded
    leading_zeroes = len(raw) - len(raw.lstrip(b"\0"))
    return "1" * leading_zeroes + (encoded or "")


def token_amount(raw: bytes) -> int:
    # SPL Token and Token-2022 keep the amount at the same base-account offset.
    if len(raw) < 72:
        raise PocError(f"token account too small: {len(raw)} bytes")
    return int.from_bytes(raw[64:72], "little")


def mint_supply(raw: bytes) -> int:
    if len(raw) < 44:
        raise PocError(f"mint account too small: {len(raw)} bytes")
    return int.from_bytes(raw[36:44], "little")


def account_pubkey(raw: bytes, offset: int) -> str:
    end = offset + 32
    if len(raw) < end:
        raise PocError(f"account too small for pubkey at offset {offset}")
    return decode_base58(raw[offset:end])


def signed_i128_le(raw: bytes, offset: int) -> int:
    end = offset + 16
    if len(raw) < end:
        raise PocError(f"account too small for i128 at offset {offset}")
    return int.from_bytes(raw[offset:end], "little", signed=True)


class Rpc:
    def __init__(self, url: str, timeout: float = 20.0) -> None:
        self.url = url
        self.timeout = timeout
        self.request_id = 0

    def call(self, method: str, params: List[Any]) -> Any:
        self.request_id += 1
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": self.request_id,
                "method": method,
                "params": params,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                result = json.load(response)
        except (urllib.error.URLError, TimeoutError) as exc:
            raise PocError(f"RPC request failed: {exc}") from exc
        if "error" in result:
            raise PocError(f"RPC error: {result['error']}")
        return result["result"]

    def get_multiple_accounts(
        self, pubkeys: Iterable[str]
    ) -> Tuple[int, Dict[str, Tuple[str, bytes]]]:
        keys = list(pubkeys)
        result = self.call(
            "getMultipleAccounts",
            [keys, {"encoding": "base64", "commitment": "confirmed"}],
        )
        context = result.get("context", {})
        slot = int(context.get("slot", 0))
        values = result.get("value", [])
        if len(values) != len(keys):
            raise PocError("RPC returned an unexpected account count")

        accounts: Dict[str, Tuple[str, bytes]] = {}
        for key, value in zip(keys, values):
            if value is None:
                raise PocError(f"account not found: {key}")
            encoded = value.get("data", [None])[0]
            if not isinstance(encoded, str):
                raise PocError(f"account data is not base64: {key}")
            accounts[key] = (value["owner"], base64.b64decode(encoded))
        return slot, accounts


@dataclass
class PoolState:
    address: str
    owner: str
    base_mint: str
    quote_mint: str
    lp_mint: str
    base_vault: str
    quote_vault: str
    lp_supply: int
    virtual_quote_reserves: int
    base_vault_amount: int
    quote_vault_amount: int
    actual_lp_supply: int
    base_mint_owner: str
    quote_mint_owner: str
    lp_mint_owner: str

    @property
    def effective_quote_reserves(self) -> int:
        return self.quote_vault_amount + self.virtual_quote_reserves


@dataclass
class SellQuote:
    base_in: int
    effective_quote_reserves: int
    raw_quote_vault_before: int
    gross_quote_out: int
    quote_out_after_fee: int
    real_vault_cap: int
    uncapped_excess: int
    fee_bps: int

    @property
    def cap_is_binding(self) -> bool:
        return self.quote_out_after_fee > self.real_vault_cap


def parse_pool(address: str, owner: str, raw: bytes) -> Dict[str, Any]:
    if len(raw) < POOL_MIN_SIZE:
        raise PocError(
            f"Pool account is {len(raw)} bytes; expected at least {POOL_MIN_SIZE}"
        )
    return {
        "address": address,
        "owner": owner,
        "base_mint": account_pubkey(raw, POOL_BASE_MINT_OFFSET),
        "quote_mint": account_pubkey(raw, POOL_QUOTE_MINT_OFFSET),
        "lp_mint": account_pubkey(raw, POOL_LP_MINT_OFFSET),
        "base_vault": account_pubkey(raw, POOL_BASE_VAULT_OFFSET),
        "quote_vault": account_pubkey(raw, POOL_QUOTE_VAULT_OFFSET),
        "lp_supply": int.from_bytes(
            raw[POOL_LP_SUPPLY_OFFSET : POOL_LP_SUPPLY_OFFSET + 8], "little"
        ),
        "virtual_quote_reserves": signed_i128_le(raw, POOL_VIRTUAL_QUOTE_OFFSET),
    }


def read_pool(rpc_url: str, pool_address: str) -> Tuple[int, PoolState]:
    rpc = Rpc(rpc_url)
    # First read only the pool. The second read batches every dependent account
    # at one RPC context, avoiding the mixed-slot issue in older probes.
    pool_owner, pool_raw = rpc.get_multiple_accounts([pool_address])[1][pool_address]
    pool = parse_pool(pool_address, pool_owner, pool_raw)

    dependent_keys = [
        pool["base_mint"],
        pool["quote_mint"],
        pool["lp_mint"],
        pool["base_vault"],
        pool["quote_vault"],
    ]
    slot, accounts = rpc.get_multiple_accounts(dependent_keys)

    def account(key: str) -> Tuple[str, bytes]:
        return accounts[key]

    base_mint_owner, _ = account(pool["base_mint"])
    quote_mint_owner, _ = account(pool["quote_mint"])
    lp_mint_owner, lp_mint_raw = account(pool["lp_mint"])
    base_vault_owner, base_vault_raw = account(pool["base_vault"])
    quote_vault_owner, quote_vault_raw = account(pool["quote_vault"])

    if base_vault_owner != base_mint_owner:
        raise PocError("base vault owner does not match base mint token program")
    if quote_vault_owner != quote_mint_owner:
        raise PocError("quote vault owner does not match quote mint token program")

    state = PoolState(
        address=pool["address"],
        owner=pool["owner"],
        base_mint=pool["base_mint"],
        quote_mint=pool["quote_mint"],
        lp_mint=pool["lp_mint"],
        base_vault=pool["base_vault"],
        quote_vault=pool["quote_vault"],
        lp_supply=pool["lp_supply"],
        virtual_quote_reserves=pool["virtual_quote_reserves"],
        base_vault_amount=token_amount(base_vault_raw),
        quote_vault_amount=token_amount(quote_vault_raw),
        actual_lp_supply=mint_supply(lp_mint_raw),
        base_mint_owner=base_mint_owner,
        quote_mint_owner=quote_mint_owner,
        lp_mint_owner=lp_mint_owner,
    )
    return slot, state


def quote_sell(
    base_reserves: int,
    effective_quote_reserves: int,
    raw_quote_vault: int,
    base_in: int,
    fee_bps: int = 0,
) -> SellQuote:
    """Quote a constant-product sell and compare it with real settlement.

    The fee is modeled as a single total fee for screening. The deployed
    program's exact fee routing should be reproduced with the official SDK
    before treating a result as a vulnerability.
    """
    if base_reserves <= 0:
        raise ValueError("base reserves must be positive")
    if effective_quote_reserves < 0:
        raise ValueError("effective quote reserves must be non-negative")
    if raw_quote_vault < 0:
        raise ValueError("raw quote vault must be non-negative")
    if not 0 < base_in < base_reserves:
        raise ValueError("base_in must be between 1 and base reserves - 1")
    if not 0 <= fee_bps < 10_000:
        raise ValueError("fee_bps must be between 0 and 9999")

    # Constant-product output before fees:
    # floor(Q_eff * x / (B + x)).
    gross = (effective_quote_reserves * base_in) // (base_reserves + base_in)
    after_fee = (gross * (10_000 - fee_bps)) // 10_000
    excess = max(0, after_fee - raw_quote_vault)
    return SellQuote(
        base_in=base_in,
        effective_quote_reserves=effective_quote_reserves,
        raw_quote_vault_before=raw_quote_vault,
        gross_quote_out=gross,
        quote_out_after_fee=after_fee,
        real_vault_cap=raw_quote_vault,
        uncapped_excess=excess,
        fee_bps=fee_bps,
    )


def quote_buy(
    base_reserves: int,
    effective_quote_reserves: int,
    base_out: int,
    fee_bps: int = 0,
) -> Dict[str, int]:
    """Return a conservative constant-product quote for buying base tokens."""
    if base_reserves <= 0:
        raise ValueError("base reserves must be positive")
    if effective_quote_reserves < 0:
        raise ValueError("effective quote reserves must be non-negative")
    if not 0 < base_out < base_reserves:
        raise ValueError("base_out must be between 1 and base reserves - 1")
    if not 0 <= fee_bps < 10_000:
        raise ValueError("fee_bps must be between 0 and 9999")

    net_quote = ceil_div(
        base_out * effective_quote_reserves, base_reserves - base_out
    )
    gross_quote = ceil_div(net_quote * 10_000, 10_000 - fee_bps)
    return {
        "base_out": base_out,
        "net_quote_in": net_quote,
        "gross_quote_in": gross_quote,
        "fee_bps": fee_bps,
    }


def validate_state(state: PoolState) -> List[str]:
    violations: List[str] = []
    if state.owner != PUMPSWAP_PROGRAM:
        violations.append("pool owner is not the PumpSwap program")
    if state.base_mint_owner not in {SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM}:
        violations.append("base mint uses an unknown token program")
    if state.quote_mint_owner not in {SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM}:
        violations.append("quote mint uses an unknown token program")
    if state.lp_mint_owner != TOKEN_2022_PROGRAM:
        violations.append("LP mint is not owned by Token-2022")
    if state.virtual_quote_reserves < 0:
        violations.append("virtual quote reserves are negative")
    if state.effective_quote_reserves < 0:
        violations.append("effective quote reserves are negative")
    if state.actual_lp_supply > state.lp_supply:
        violations.append("actual LP supply exceeds Pool::lp_supply")
    return violations


def state_report(slot: int, state: PoolState, sell: SellQuote, buy: Dict[str, int]) -> Dict[str, Any]:
    violations = validate_state(state)
    findings: List[Dict[str, Any]] = []

    if sell.cap_is_binding:
        findings.append(
            {
                "id": "REAL_VAULT_CAP_REQUIRED",
                "severity": "candidate",
                "detail": (
                    "The effective-reserve sell quote exceeds the real quote "
                    "vault. The documented program behavior should reject or "
                    "cap settlement; this is not an exploit by itself."
                ),
                "uncapped_excess": sell.uncapped_excess,
            }
        )
    else:
        findings.append(
            {
                "id": "NO_SETTLEMENT_CAP_GAP_IN_SCREENED_TRADE",
                "severity": "info",
                "detail": "The screened sell quote fits inside the real quote vault.",
            }
        )

    if state.virtual_quote_reserves == 0:
        findings.append(
            {
                "id": "VIRTUAL_RESERVE_INACTIVE",
                "severity": "info",
                "detail": "This pool has no virtual quote reserve, so the suspected pricing/settlement split is inactive.",
            }
        )

    return {
        "mode": "read_only_screening_poc",
        "slot": slot,
        "pool": asdict(state),
        "derived": {
            "effective_quote_reserves": state.effective_quote_reserves,
            "screened_sell": asdict(sell),
            "screened_buy": buy,
        },
        "violations": violations,
        "findings": findings,
        "verdict": (
            "INVARIANT_VIOLATION"
            if violations
            else "CANDIDATE_REQUIRES_TRANSACTION_POC"
            if sell.cap_is_binding
            else "NO_SCREENED_ANOMALY"
        ),
        "limitations": [
            "No transaction was built, signed, simulated, or sent.",
            "Fee math is a configurable screening approximation; reproduce exact fee routing with the official SDK.",
            "A cap-required quote is expected behavior if the deployed instruction rejects or caps it.",
        ],
    }


def run_self_test() -> None:
    # With no virtual reserve, the effective and real quote models agree.
    normal = quote_sell(
        base_reserves=1_000_000,
        effective_quote_reserves=100_000,
        raw_quote_vault=100_000,
        base_in=10_000,
    )
    assert normal.uncapped_excess == 0

    # A synthetic virtual reserve can create a quote above real settlement.
    candidate = quote_sell(
        base_reserves=1_000_000,
        effective_quote_reserves=1_000_000_000,
        raw_quote_vault=10_000,
        base_in=100_000,
    )
    assert candidate.cap_is_binding
    assert candidate.uncapped_excess > 0

    buy = quote_buy(
        base_reserves=1_000_000,
        effective_quote_reserves=100_000,
        base_out=10_000,
    )
    assert buy["gross_quote_in"] >= buy["net_quote_in"] > 0
    print("self-test: PASS")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", default=DEFAULT_RPC)
    parser.add_argument("--pool", help="PumpSwap Pool account to inspect")
    parser.add_argument(
        "--sell-base-in",
        type=int,
        help="Base units to screen; defaults to max(1, base_vault / 1000)",
    )
    parser.add_argument(
        "--fee-bps",
        type=int,
        default=25,
        help="Approximate total fee for screening only (default: 25)",
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        run_self_test()
        return 0
    if not args.pool:
        parser.error("--pool is required unless --self-test is used")

    try:
        slot, state = read_pool(args.rpc, args.pool)
        base_in = args.sell_base_in or max(1, state.base_vault_amount // 1_000)
        if base_in >= state.base_vault_amount:
            raise PocError(
                f"screened sell amount {base_in} must be below base vault "
                f"{state.base_vault_amount}"
            )
        sell = quote_sell(
            state.base_vault_amount,
            state.effective_quote_reserves,
            state.quote_vault_amount,
            base_in,
            args.fee_bps,
        )
        buy = quote_buy(
            state.base_vault_amount,
            state.effective_quote_reserves,
            min(base_in, state.base_vault_amount - 1),
            args.fee_bps,
        )
        print(json.dumps(state_report(slot, state, sell, buy), indent=2))
        return 2 if validate_state(state) else 0
    except (PocError, ValueError) as exc:
        print(f"POC ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())