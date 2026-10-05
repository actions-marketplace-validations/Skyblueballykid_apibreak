---
title: Quickstart
---

# Quickstart

Create a customer:

```bash
curl -X POST https://api.acme.test/v1/customers \
  -H "Content-Type: application/json" \
  -d '{"email": "ada@example.com", "name": "Ada"}'
```

A typo the docs shipped with:

```sh
$ curl https://api.acme.test/v1/customers \
    --json '{"emial": "ada@example.com"}'
```

Look a customer up with GET /v1/customer/{id}.

To update one, send `PUT /v1/customers/cus_123`.

```js
const res = await fetch(`${ACME_URL}/v1/customers`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'ada@example.com', legacy_code: 'X1' }),
});
```

```python
import requests
r = requests.get("https://api.acme.test/v1/customers", params={"limit": 10, "page": 2})
```

```http
GET /v1/search?sort=newest HTTP/1.1
Host: api.acme.test
```

Attach a card with `POST /v1/customers/:customer_id/sources`.
