# Security policy

## Reporting a vulnerability

Do not report security vulnerabilities in a public issue. Use the repository host's private security-advisory feature or contact the project owner through an approved private channel.

Include the affected route or component, reproduction steps, impact, and any suggested mitigation. Do not include active tokens, secret values, customer data, or production URLs in the report.

## Deployment model

This repository is a demonstration and does not include application-level administrator authentication. Its control endpoints can mutate or delete demonstration state. The committed Wrangler configuration is intentionally unreachable after deployment until an operator adds a route.

Operators must protect administrative routes with Cloudflare Access or equivalent controls, restrict ingest endpoints with WAF and source policy, and keep media delivery behind the included token validation.

The token scheme places credentials in query strings and publisher URL paths. Request URLs must be redacted before they enter Workers Logs, traces, Logpush, WAF event exports, analytics systems, or support captures.

## Secrets

Store signing and ingest values as encrypted Worker secrets. Never commit secret values, local Wrangler state, `.dev.vars`, `.env`, generated publisher commands, or screenshots containing credentials.

Rotate the primary and transition access keys using an overlap period that allows active sessions to finish. Use separate random values for access signing, session signing, and ingest authentication.

## Scope

Only the latest `main` branch is maintained. This project has not completed a third-party security assessment and should not be treated as production-ready without an independent review.
