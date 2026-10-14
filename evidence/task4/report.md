# A05 — SQL Injection (Trip Search)

## Vulnerability

The `q` search parameter on `GET /api/trips` was concatenated directly into the SQL `WHERE` clause instead of being bound as a query parameter, allowing an attacker to alter the query's logical structure and bypass the `is_published=true` filter.

## Exploitation

A single apostrophe (`?q='`) returned a `500`, proving the input broke out of the SQL string. Reading the query (`is_published=true AND (title ILIKE '%<q>%' OR ...)`), the payload `%') OR (title ILIKE '%` closes the string and the open parenthesis, then re-opens a true `OR` branch that matches every row. This revealed the unpublished internal trip `archive-search-party`, whose description carried `FLAG{a05_f18576d329621a5302236616}`.

## Root Cause

```ts
const filter = query
  ? ` AND (title ILIKE '%${query}%' OR destination ILIKE '%${query}%' OR description ILIKE '%${query}%')`
  : '';
```
User input was interpolated as SQL text instead of being passed as data.

## Remediation

`catalog.ts`: the search value is now bound as `$1`, passed in a separate `params` array to `pool.query`, with the SQL text kept constant:
```ts
const filter = query ? ` AND (title ILIKE $1 OR destination ILIKE $1 OR description ILIKE $1)` : '';
const params = query ? [`%${query}%`] : [];
```

## Verification

Regression tests: the SQL sent to `pool.query` no longer contains the injected predicate and uses `$1`; the injection payload no longer returns the unpublished trip or the flag. Business test: an ordinary search (`Kyoto`) still returns the matching trip. Full suite passing — see `passing-tests.png`.