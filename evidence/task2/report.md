# A03 — Supply Chain Integrity (Destination Pack)

## Vulnerability

`loadDestinationPack()` computed a SHA-256 digest of the supplier file but never compared it to the trusted expected digest before parsing and returning the content. The route layered on a check that only flipped a label (`accepted: true`) instead of rejecting the mismatch, and still served the altered pack. The runtime was configured to load the altered fixture while the trusted digest in configuration was the approved one, so the mismatch was present and silently ignored. Any tampered pack was trusted and served to the public catalogue.

## Exploitation

`GET /api/destination-pack` returned `integrity.expected` ≠ `integrity.calculated` yet `accepted: true`, and the `kyoto-saisons` entry carried an unapproved travel tip containing `FLAG{a03_9f6a0571f7956cacedf7de1b}`. The same tampered data was also exposed through `/api/trips`.

## Root Cause

```ts
const pack = JSON.parse(raw.toString('utf8')) as DestinationPack; // parsed before verification
return { pack, integrity: { expected, calculated, accepted: true } }; // hardcoded
```
No comparison between `calculated` and `expected` ever happened; the content was parsed and trusted unconditionally.

## Remediation

- `destination-pack.ts`: compare `calculatedSha256` to `expectedSha256` **before** `JSON.parse`; throw on mismatch.
- `catalog.ts`: wrap the loader call in `try/catch`; on failure, log details server-side and return a generic non-sensitive error to the client.
- `compose.yaml` / `.env.example` / `config.ts`: point the runtime at the **approved** fixture with its matching digest.

## Verification

Regression test: the altered pack is rejected before parsing (`JSON.parse` spy never called). Business test: the approved pack loads successfully with matching digest. Full suite passing — see `passing-tests.png`.