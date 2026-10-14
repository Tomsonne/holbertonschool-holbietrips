# A06 — Insecure Design (Coupon Stacking)

## Vulnerability

The booking endpoint accepted a single `couponCode` field in its UI and API contract, but the backend silently split it on commas into a list and applied a discount for every entry in a loop. No rule ever enforced "zero or one coupon per booking", so a customer could repeat or stack codes to compound discounts and push the total below the intended price.

## Exploitation

A normal booking with one `BIENVENUE10` coupon served as the pricing baseline. Submitting the same booking (same trip, same traveler count) with `couponCode: "BIENVENUE10,BIENVENUE10"` applied the 10% discount twice, producing a lower total than the baseline and confirming the stacking. The booking-creation response's `itinerary_notes` carried `FLAG{a06_<redacted>}` — present only in that immediate response, not persisted or shown when reopening the booking later.

## Root Cause

```ts
const couponCodes = readText(body.couponCode, 120).toUpperCase().split(',').map(c => c.trim()).filter(Boolean);
...
for (const couponCode of couponCodes) {
  total = applyCoupon(total, { discountPercent: coupon.discount_percent, minimumCents: coupon.minimum_cents });
}
```
No validation ever restricted `couponCodes` to at most one entry — a missing business rule, not an implementation bug in the loop itself.

## Remediation

`bookings.ts`: the one-coupon rule is enforced explicitly, before any database write:
```ts
if (couponCodes.length > 1) {
  return reply.code(400).send({ error: 'Un seul coupon est autorisé par réservation' });
}
```
Placed before `pool.connect()`/`BEGIN`, so a rejected request never opens a transaction or touches `bookings`, `coupons`, or `trips`.

## Verification

Regression test: stacked/duplicate coupons return `400`, no flag, and `pool.connect`/`client.query` are never called (no writes). Business tests: a single valid coupon applies one discount; a booking without a coupon pays full price. Full suite passing — see `passing-tests.png`.