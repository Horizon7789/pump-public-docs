#!/usr/bin/env python3
"""Permissionless PumpSwap invariant probe.

This is intentionally fail-closed: it does not claim an exploit merely because
an unusual state is observed. It reports concrete invariant violations and
requires a human/PoC follow-up before calling anything exploitable.
"""

import argparse
import base64
import json
import struct
import sys
import urllib.request

# Anchor account data includes an 8-byte discriminator before Pool fields.
# Pool layout (current public docs):
# discriminator(8), pool_bump(u8), index(u16), creator(pubkey),
# base_mint(pubkey), quote_mint(pubkey), lp_mint(pubkey),
# pool_base_token_account(pubkey), pool_quote_token_account(pubkey),
# lp_supply(u64), coin_creator(pubkey), is_mayhem_mode(bool),
# is_cashback_coin(bool), virtual_quote_reserves(i128).
POOL_BUMP_OFFSET = 8
POOL_INDEX_OFFSET = 9
POOL_CREATOR_OFFSET = 11
POOL_BASE_MINT_OFFSET = 43
POOL_QUOTE_MINT_OFFSET = 75
POOL_LP_MINT_OFFSET = 107
POOL_BASE_VAULT_OFFSET = 139
POOL_QUOTE_VAULT_OFFSET = 171
POOL_LP_SUPPLY_OFFSET = 203
POOL_COIN_CREATOR_OFFSET = 211
POOL_MAYHEM_OFFSET = 243
POOL_CASHBACK_OFFSET = 244
POOL_VIRTUAL_QUOTE_OFFSET = 245
POOL_MIN_SIZE = POOL_VIRTUAL_QUOTE_OFFSET + 16

SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as response:
        data = json.load(response)
    if "error" in data:
        raise RuntimeError(data["error"])
    return data["result"]


def account(url, pubkey):
    result = rpc(url, "getAccountInfo", [pubkey, {"encoding": "base64"}])
    value = result["value"]
    if value is None:
        raise RuntimeError(f"account not found: {pubkey}")
    raw = base64.b64decode(value["data"][0])
    return value, raw


def pubkey(raw, offset):
    return base58(raw[offset:offset + 32])


def base58(data):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = alphabet[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + (out or "")


def token_account_amount(raw):
    if len(raw) < 72:
        raise RuntimeError("token account is too small")
    return struct.unpack_from("<Q", raw, 64)[0]


def mint_supply(raw):
    if len(raw) < 44:
        raise RuntimeError("mint account is too small")
    return struct.unpack_from("<Q", raw, 36)[0]


def signed_i128_le(raw, offset):
    if len(raw) < offset + 16:
        raise RuntimeError("account is too small for i128")
    return int.from_bytes(raw[offset:offset + 16], "little", signed=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", required=True)
    ap.add_argument("--pool", required=True)
    ap.add_argument("--pumpswap-program", required=True)
    ap.add_argument("--token-program", default=SPL_TOKEN)
    ap.add_argument("--token-2022-program", default=TOKEN_2022)
    args = ap.parse_args()

    report = {"pool": args.pool, "checks": [], "violations": [], "warnings": []}

    pool_meta, pool = account(args.rpc, args.pool)
    report["pool_owner"] = pool_meta["owner"]

    if pool_meta["owner"] != args.pumpswap_program:
        report["violations"].append({
            "id": "POOL_OWNER_MISMATCH",
            "severity": "critical",
            "detail": "Target account is not owned by the expected PumpSwap program."
        })
    else:
        report["checks"].append("POOL_OWNER_MATCH")

    if len(pool) < POOL_MIN_SIZE:
        raise RuntimeError(f"Pool account too small for documented layout: {len(pool)} bytes")

    lp_supply = struct.unpack_from("<Q", pool, POOL_LP_SUPPLY_OFFSET)[0]
    virtual_quote = signed_i128_le(pool, POOL_VIRTUAL_QUOTE_OFFSET)
    base_mint = pubkey(pool, POOL_BASE_MINT_OFFSET)
    quote_mint = pubkey(pool, POOL_QUOTE_MINT_OFFSET)
    lp_mint = pubkey(pool, POOL_LP_MINT_OFFSET)
    base_vault = pubkey(pool, POOL_BASE_VAULT_OFFSET)
    quote_vault = pubkey(pool, POOL_QUOTE_VAULT_OFFSET)

    report["state"] = {
        "lp_supply": lp_supply,
        "virtual_quote_reserves": virtual_quote,
        "base_mint": base_mint,
        "quote_mint": quote_mint,
        "lp_mint": lp_mint,
        "base_vault": base_vault,
        "quote_vault": quote_vault,
    }

    # 1. Virtual quote reserve accounting.
    base_meta, base_raw = account(args.rpc, base_vault)
    quote_meta, quote_raw = account(args.rpc, quote_vault)
    base_amount = token_account_amount(base_raw)
    quote_amount = token_account_amount(quote_raw)
    effective_quote = quote_amount + virtual_quote

    report["reserve_check"] = {
        "raw_quote_vault": quote_amount,
        "virtual_quote_reserves": virtual_quote,
        "effective_quote_reserves": effective_quote,
        "raw_base_vault": base_amount,
    }

    if virtual_quote < 0:
        report["violations"].append({
            "id": "NEGATIVE_VIRTUAL_QUOTE_RESERVES",
            "severity": "high",
            "detail": "Pool carries a negative virtual quote reserve; verify all pricing and settlement paths."
        })
    else:
        report["checks"].append("VIRTUAL_RESERVE_SIGN")

    if effective_quote < 0:
        report["violations"].append({
            "id": "NEGATIVE_EFFECTIVE_QUOTE_RESERVES",
            "severity": "critical",
            "detail": "Effective quote reserves are negative."
        })
    else:
        report["checks"].append("EFFECTIVE_QUOTE_NONNEGATIVE")

    # 2. LP accounting: compare stored logical supply with actual mint supply.
    lp_meta, lp_raw = account(args.rpc, lp_mint)
    actual_lp_supply = mint_supply(lp_raw)
    report["lp_check"] = {
        "pool_lp_supply": lp_supply,
        "actual_lp_mint_supply": actual_lp_supply,
        "lp_mint_owner_program": lp_meta["owner"],
    }

    # Pool::lp_supply is documented as excluding direct user burns, so a lower
    # mint supply is not automatically a bug. A larger mint supply is different:
    # it means claims can exist outside the accounting baseline.
    if actual_lp_supply > lp_supply:
        report["violations"].append({
            "id": "LP_MINT_SUPPLY_EXCEEDS_POOL_SUPPLY",
            "severity": "high",
            "detail": "Actual LP mint supply exceeds Pool::lp_supply; investigate whether excess claims can redeem reserves."
        })
    else:
        report["checks"].append("LP_SUPPLY_UPPER_BOUND")

    # 3. Token-2022 / SPL consistency.
    for label, mint, vault, vault_meta in [
        ("base", base_mint, base_vault, base_meta),
        ("quote", quote_mint, quote_vault, quote_meta),
    ]:
        mm, _ = account(args.rpc, mint)
        expected = {args.token_program, args.token_2022_program}
        if mm["owner"] not in expected:
            report["violations"].append({
                "id": f"{label.upper()}_MINT_UNKNOWN_TOKEN_PROGRAM",
                "severity": "high",
                "detail": f"{label} mint is owned by unexpected program {mm['owner']}."
            })
        if vault_meta["owner"] != mm["owner"]:
            report["violations"].append({
                "id": f"{label.upper()}_VAULT_MINT_PROGRAM_MISMATCH",
                "severity": "critical",
                "detail": f"{label} vault token program does not match its mint token program."
            })
        else:
            report["checks"].append(f"{label.upper()}_TOKEN_PROGRAM_MATCH")

    report["warnings"].append(
        "Static account-state checks cannot prove swap/withdraw exploitability; run transaction-level PoCs for any violation."
    )

    with open("audit-report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)

    print(json.dumps(report, indent=2, sort_keys=True))
    if report["violations"]:
        print(f"\nFAIL: {len(report['violations'])} invariant violation(s) found.", file=sys.stderr)
        return 1
    print(f"\nPASS: {len(report['checks'])} invariant checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
