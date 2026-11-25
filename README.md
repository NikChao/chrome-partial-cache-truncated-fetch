# Chrome: fetch() resolves with a truncated body after a partial cache entry

A `fetch()` for a whole resource resolves with status 200 and the full `Content-Length`, but the body
contains only the range that was already in the HTTP cache. No error is raised.

## Run

    node server.mjs

Open http://localhost:8080/ in Chrome. The page prints PASS or FAIL. The terminal prints each request the
server receives and how it answers. Node 18 or later is required. There are no dependencies.

## What the page does

1. `fetch(url, { headers: { Range: 'bytes=0-65535' } })`, then reads the body. The cache stores a partial entry.
2. `fetch(url)` with no `Range` header, then reads the body.

## Expected

Step 2 resolves with all 2,000,000 bytes, or it rejects.

## Actual

Step 2 resolves with status 200 and `Content-Length: 2000000`. The body ends after 65,536 bytes.

## What the server sees for step 2

    Range: bytes=0-65535        Accept-Encoding: gzip, deflate, br, zstd   If-None-Match: "<etag>"
       -> 304, ETag: W/"<etag>"
    Range: bytes=65536-1999999  Accept-Encoding: gzip, deflate, br, zstd   If-Range: "<etag>"
       -> 200, Content-Encoding: br, whole resource

The cache revalidates its partial entry and receives a 304. `If-None-Match` uses weak comparison, and the
compressed representation carries the weak form of the same ETag. The cache then requests the remaining
bytes with `If-Range` set to the strong ETag. `If-Range` uses strong comparison, so the server sends the
whole compressed representation as a 200. The response given to the page ends at the cached range.

## The server

`server.mjs` models a CDN that compresses on the fly. Amazon CloudFront in front of S3 behaves this way.

- A request that does not accept `br` gets the identity representation with a strong ETag. Ranges are honoured.
- A request that accepts `br` gets the compressed representation with a weak ETag. `Range` is ignored.

Chrome sends `Accept-Encoding: identity` when a script sets `Range`, so step 1 stores an identity range.
The requests the cache makes for step 2 accept `br`.

## Tested

- Chrome 158.0.8127.89 on macOS (arm64): fails on every run.
- Chromium 156.0.8078.4 (Playwright build, headless) on macOS (arm64): fails on every run.
