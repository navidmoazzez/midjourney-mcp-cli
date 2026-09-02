# Security

## Reporting a vulnerability

Report privately through GitHub:
[open a security advisory](https://github.com/navidmoazzez/midjourney-mcp-cli/security/advisories/new).

Please do not open a public issue for a vulnerability.

## What this server can reach

It holds no credential. The Midjourney session lives in a Chrome profile at
`~/.midjourney-mcp/chrome-profile`, and this process only tells that browser to
make requests. It never reads a cookie, stores a token, or sees a password.

That browser profile is the sensitive thing on disk. Anyone who can read it can
act as the signed-in Midjourney account, exactly as with any browser profile.

The DevTools port it drives listens on loopback only. Do not expose it: anything
that can reach that port can drive the browser, and therefore the account.

## Running it over HTTP

`--http` refuses to listen on anything but loopback without
`MIDJOURNEY_HTTP_TOKEN`, because the server acts as a signed-in account and can
spend money from a paid plan.

## Limiting what an agent can do

`MIDJOURNEY_READ_ONLY=1` removes every tool that is not a read, so a model
cannot call one it cannot see. `MIDJOURNEY_ALLOW_DESTRUCTIVE=0` keeps reads and
downloads while blocking anything that spends. `MIDJOURNEY_AUDIT_LOG=<path>`
records every attempted change, allowed and blocked alike.

## Supported versions

The latest published version is the supported one.
