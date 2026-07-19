# Private Label Authentication and Caching

**Status:** Proposed  
**Date:** 2026-07-16  
**Target:** Cloudflare Workers + Workers Caching + private R2  
**Scope:** Proposed native authentication for deployments that cannot rely only
on an external platform policy.

## 1. Summary

Yes, the common case can be:

1. An existing OAuth 2.0 or OpenID Connect authorization server issues a JWT access token.
2. The client sends it to RDF Label Cache as `Authorization: Bearer <token>`.
3. An uncached Worker entrypoint validates the token and authorizes the label request.
4. The gateway calls a separate, cached Worker entrypoint using `ctx.exports`.
5. The cached entrypoint serves an authorization-partitioned response from Workers Caching, or reads it from private R2 on a cache miss.

The important qualification is that the current cache cannot remain in front of the authentication code. Workers Caching currently checks its cache before invoking a cached entrypoint. A hit on the current default entrypoint would therefore skip JWT validation. The current response header, `Cache-Control: public, ...`, also permits a response to an authorized request to be stored.

The proposed design uses Cloudflare's per-entrypoint cache controls:

```text
Client
  |
  | Authorization: Bearer <JWT>
  v
Default entrypoint: Auth Gateway                 cache disabled
  |  validate signature, issuer, audience, time
  |  authorize scope/tenant/resource
  |  remove credentials and build trusted cache key
  v
PrivateLabels entrypoint via ctx.exports         cache enabled, tiered
  |  HIT: return cached label
  |  MISS
  v
Private R2 binding                               bucket has no public endpoint
```

This retains tiered edge caching of label bytes and avoids repeated R2 reads. It intentionally does not avoid the small authentication gateway invocation: every private request must cross a live authorization boundary.

## 2. Decision

Implement a provider-neutral JWT resource server in the Worker, with these initial constraints:

| Item | MVP decision |
|---|---|
| Token | Signed JWT access token |
| Transport | `Authorization: Bearer` over HTTPS |
| Issuers | One statically configured issuer |
| Keys | Asymmetric signing keys from a configured JWKS URI |
| Audience | One required API audience |
| Authorization | Required `labels:read` scope or configured equivalent |
| Data boundary | One private label set per deployment |
| Cache partition | One constant private deployment partition |
| R2 | Existing key layout in a non-public bucket |
| Browser cache | `private`; no shared downstream caching |
| Cloudflare cache | Named inner entrypoint only |

Do not implement login, redirects, refresh tokens, token issuance, or user management. RDF Label Cache is the resource server. The application or cloud identity provider remains responsible for obtaining and refreshing tokens.

Multi-issuer, multi-tenant, per-namespace authorization, and opaque tokens are extensions described below, not requirements for the first implementation.

## 3. Goals and non-goals

### Goals

- Protect label values, namespace metadata, and private context documents from unauthenticated access.
- Accept access tokens from common cloud and SaaS identity providers without provider-specific code in the request path.
- Validate authentication and authorization on every private request, including an inner cache hit.
- Share cached bytes only between principals that are allowed to receive identical bytes.
- Preserve the existing R2 object format, streaming, language variants, and tag-based invalidation.
- Fail closed when identity configuration, token validation, or authorization is uncertain.
- Keep public-only deployments as simple and fast as they are now.

### Non-goals

- Acting as an OAuth authorization server or identity provider.
- Storing passwords, refresh tokens, login sessions, or client secrets for end users.
- Treating possession of any JWT as authorization.
- Supporting arbitrary issuers discovered from an unverified token.
- Solving general RDF graph authorization. This design authorizes pre-materialized label documents only.
- Hiding the IRI requested from Cloudflare or from service operators. Query strings are present in request and cache metadata.

## 4. Current state and risk

The current request path is:

```text
Workers Caching -> default Worker fetch -> PUBLIC_LABELS.get(r2Key)
```

Successful labels use:

```http
Cache-Control: public, max-age=3600, s-maxage=31536000, stale-while-revalidate=604800
Cache-Tag: labels
```

That is correct for public data. It is unsafe to add a bearer check inside the current cached handler without changing the cache topology. Cloudflare documents that enabling Workers Caching causes the cache to be checked before the Worker entrypoint runs. It also documents that requests containing `Authorization` can still be cached when the response explicitly includes `public`, `must-revalidate`, or `s-maxage`.

Adding `Vary: Authorization` is not a solution:

- It creates roughly one cache variant per token and destroys sharing.
- A cache hit still does not revalidate token expiry, revocation, or current policy.
- Raw credentials become cache-key material.
- Equivalent users with different tokens do not share entries.

The security invariant is instead: **authentication runs first; caching happens only behind it**.

## 5. Threat model and invariants

The design protects against:

- Missing, expired, not-yet-valid, malformed, or incorrectly signed tokens.
- Tokens issued by an untrusted issuer.
- Valid tokens intended for a different API audience.
- Algorithm confusion, unsigned tokens, and untrusted JWKS locations.
- A user in one tenant receiving an object cached for another tenant.
- Public or intermediary caches storing private responses from the external API.
- Direct public access to R2 that bypasses the Worker.
- Cache poisoning through attacker-controlled authorization partition values.

The design does not make a stateless JWT instantly revocable. Revocation behavior remains a property of the identity system and token lifetime. If immediate revocation is required, use token introspection, a provider-enforced gateway checked on every request, or a short-lived token plus a denylist mechanism.

The following invariants are mandatory:

1. Every external private-data request invokes the authentication gateway.
2. Only the gateway can call the cached private entrypoint.
3. The inner cache key contains every trusted input that can change response bytes or access class.
4. A raw token, cookie, email address, or unverified claim is never a cache key.
5. `401`, `403`, and identity-provider failures are never cached.
6. The external response never advertises shared-cache eligibility for private data.
7. R2 is private independently of Worker authentication.

## 6. Detailed request flow

### 6.1 Token acquisition

The label service does not care how the client authenticated, provided the result is a valid access token for this API.

Common acquisition flows are:

| Client | Normal flow | Result seen by label service |
|---|---|---|
| Browser or native app | Authorization Code + PKCE | Bearer access token |
| Server application | Client Credentials | Bearer access token representing the workload |
| API acting for a user | On-behalf-of or token exchange | Bearer access token for the label API |
| Cloudflare Access client | IdP login or service token | Access application JWT header/cookie |

The browser should not send an ID token merely because it is a JWT. An ID token proves authentication to its client application; an access token authorizes calls to a resource server. A provider-specific adapter may explicitly accept an ID token, but it must use a dedicated audience and documented semantics. That should not be the default.

### 6.2 Gateway processing

For `GET /label` and any private context route:

1. Reject unsupported methods and oversized authorization headers.
2. Read exactly one supported credential source.
3. Select an issuer only from static configuration.
4. Validate the token cryptographically and semantically.
5. Map provider claims into an internal `AuthContext`.
6. Authorize the route and requested IRI before looking in the inner cache.
7. Derive an opaque cache partition from trusted authorization context.
8. Canonicalize the internal URL and remove all caller credentials.
9. Call `ctx.exports.PrivateLabels.fetch(internalRequest)`.
10. Add external-only headers such as CORS and `Cache-Control: private`.

Suggested internal representation:

```ts
interface AuthContext {
  issuer: string;
  subject: string;
  audience: string[];
  scopes: Set<string>;
  roles: Set<string>;
  tenantId?: string;
  cachePartition: string;
}
```

Do not pass the full claims object to storage code. Normalize only claims used by authorization.

### 6.3 Inner cache and R2 processing

The inner request uses a canonical, internal-only URL such as:

```text
https://private-cache.invalid/v1/p/<partition>/label?iri=<encoded>&lang=en
```

`<partition>` is calculated by the gateway, for example:

```text
base64url(SHA-256(cache-schema-version || issuer || tenant || access-class))
```

It is not accepted from an external query parameter or header. The hash avoids placing tenant names or subjects in cache telemetry. It is a partition identifier, not an authorization secret.

The gateway also canonicalizes:

- Query parameter order.
- IRI encoding and decoding exactly once.
- Language tag syntax and case policy.
- Optional representation selectors.
- The internal host and scheme.

On an inner cache miss, `PrivateLabels` maps the request to R2 and streams the
existing JSON-LD object. On a hit, the private entrypoint does not run, but this
is safe because the uncached gateway has already validated and authorized the
request.

### 6.4 Response behavior

External responses should use:

```http
Cache-Control: private, max-age=300
```

`private` allows a user agent to cache a response while prohibiting shared downstream caches. Use `no-store` instead if labels are sufficiently sensitive that browser persistence is unacceptable.

The inner call can independently receive an edge policy such as:

```ts
return ctx.exports.PrivateLabels.fetch(internalRequest, {
  cf: { cacheControl: "public, max-age=86400, stale-if-error=86400" },
});
```

Alternatively, the inner response can set `Cloudflare-CDN-Cache-Control`, which Cloudflare consumes while leaving the external `Cache-Control` semantics private. The `cf.cacheControl` loopback override is preferable because it keeps private edge policy at the trusted gateway call site.

Recommended status behavior:

| Result | Status | External cache policy | Inner cache policy |
|---|---:|---|---|
| Label found | 200 | `private, max-age=300` | Cache by partition and URL |
| Label absent | 404 | `private, max-age=30` | Optional short negative cache by partition |
| Missing/invalid token | 401 | `no-store` | Never reaches inner cache |
| Insufficient permission | 403 | `no-store` | Never reaches inner cache |
| Invalid request | 400 | `no-store` | Prefer rejection before inner cache |
| IdP/JWKS unavailable | 503 | `no-store` | Never reaches inner cache |
| R2/internal failure | 5xx | `no-store` | Do not store a new error response |

Use `401` with `WWW-Authenticate: Bearer` for a missing or invalid credential. Use `403` only after a credential is valid but lacks permission. Error bodies must not reveal whether a private IRI exists.

## 7. JWT validation profile

Use a well-maintained JOSE implementation, such as `jose`, rather than custom parsing or signature code.

For each configured issuer, define:

```ts
interface IssuerConfig {
  issuer: string;
  jwksUri: string;
  audiences: string[];
  algorithms: string[];
  requiredScopes: string[];
  tokenKind: "access" | "cloudflare-access" | "provider-specific";
  scopeClaim?: string;
  rolesClaim?: string;
  tenantClaim?: string;
}
```

Validation must include:

- Parse only after enforcing a conservative token size limit.
- Match `iss` exactly to a configured issuer.
- Obtain keys only from that issuer's configured HTTPS JWKS URI.
- Match `kid` to a current JWKS key and support key rotation.
- Pin the accepted asymmetric algorithms per issuer and reject `alg: none`.
- Verify the signature before trusting any claim.
- Require that `aud` contains the configured label API audience.
- Require and validate `exp`; validate `nbf` when present.
- Allow only a small configured clock skew.
- Validate the provider's access-token type marker where it has one.
- Require `labels:read`, an application role, or an explicitly configured equivalent.
- Treat missing or wrongly typed authorization claims as denial.

For an RFC 9068 access token, require `typ` to be `at+jwt` or `application/at+jwt`. Some established providers do not emit RFC 9068 tokens; support those through explicit issuer adapters rather than weakening the generic profile for every issuer.

JWKS and discovery rules:

- Configure the issuer and audience at deploy time; they are identifiers, not secrets.
- Discovery may be performed from the configured issuer, never from an arbitrary `iss` value in an unverified token.
- Cache successful JWKS results in the JOSE resolver and respect rotation.
- If a known cached key validates the token, an IdP outage need not fail that request.
- If a token references an unknown key and refresh fails, fail closed with `503` or `401` according to operational policy.
- Do not keep one hard-coded public key indefinitely.

JWT validation proves claims were issued by a trusted authority. Authorization still requires checking those claims against the requested resource.

## 8. Authorization and cache partition models

### 8.1 Deployment-wide private labels, recommended MVP

Any valid token with `labels:read` can read every label in this deployment.

```text
R2 key:          labels/{lang}/{iri}
Cache partition: private-v1
```

No R2 key migration is required. All authorized callers share label cache entries, but the gateway validates each request first.

This is the common case and should be implemented first.

### 8.2 Multi-tenant labels

The token contains a trusted tenant identifier, or the Worker maps issuer plus subject to one. R2 and cache keys must both include the tenant boundary.

```text
R2 key:          tenants/{storageTenant}/labels/{lang}/{iri}
Cache partition: hash(issuer, tenant, policyVersion)
```

Do not concatenate a raw claim into an R2 path without validation and canonicalization. Prefer a configured mapping from external tenant IDs to opaque storage IDs.

### 8.3 Role or group access classes

If several groups may see different label sets, map the verified claims into a small, stable access class such as `employees`, `partners`, or `research-project-7`.

The access class must be included in the cache partition. Do not hash an unordered raw groups array directly. Normalize it through authorization policy first, or cache fragmentation and subtle equivalence errors will result.

Provider group claims can be incomplete or indirect. For example, some providers emit an overage marker instead of all groups. Prefer application roles or scopes that are intended for the API.

### 8.4 Per-user labels

Include issuer plus `sub` in both the authorization mapping and cache partition. This is correct but has the lowest sharing and highest cache cardinality. Use it only when label bytes truly vary by user.

### 8.5 Per-namespace or per-label ACLs

Authorize the canonical IRI before the inner cache call. Include the resulting data partition or policy class in the inner key. If policy requires a database lookup, that lookup remains in the uncached gateway path.

For highly dynamic object ACLs, caching label bytes is still possible because authorization runs first. Do not cache authorization decisions longer than their required revocation window.

### 8.6 Mixed public and private data

Prefer separate hostnames and separate R2 bindings or buckets:

```text
labels.example.com          public entrypoint and public cache policy
private-labels.example.com  auth gateway and private cached entrypoint
```

An explicit `/public/...` and `/private/...` split is acceptable if hostnames are inconvenient. Do not try public storage first and silently fall back to private storage under one cache identity. Explicit separation makes cache headers, CORS, monitoring, and incident response easier to reason about.

## 9. Cloudflare and R2 changes

### 9.1 Wrangler configuration

Per-entrypoint caching requires Wrangler 4.107.0 or newer. The repository already uses that version range. `ctx.exports` also requires the `enable_ctx_exports` compatibility flag.

Conceptual TOML:

```toml
compatibility_date = "2026-07-16"
compatibility_flags = ["enable_ctx_exports"]

[cache]
enabled = true

[exports.default]
type = "worker"
  [exports.default.cache]
  enabled = false

[exports.PrivateLabels]
type = "worker"
  [exports.PrivateLabels.cache]
  enabled = true

[[r2_buckets]]
binding = "PRIVATE_LABELS"
bucket_name = "label-cache-private"

[vars]
AUTH_MODE = "jwt"
AUTH_ISSUER = "https://issuer.example.com/"
AUTH_AUDIENCE = "https://private-labels.example.com"
AUTH_REQUIRED_SCOPES = "labels:read"
AUTH_JWKS_URI = "https://issuer.example.com/.well-known/jwks.json"
AUTHZ_POLICY_VERSION = "1"
```

The exact generated types should come from `wrangler types`; do not maintain `ctx.exports` or binding types by hand.

### 9.2 Worker structure

Expected code changes:

| Area | Change |
|---|---|
| `src/index.ts` | Make the default export the uncached auth/router gateway; export `PrivateLabels extends WorkerEntrypoint` |
| `src/lib/auth.ts` | Credential extraction, issuer selection, JOSE validation, claim normalization |
| `src/lib/authorize.ts` | Scope, role, tenant, and route authorization |
| `src/lib/private-cache-key.ts` | Canonical URL and opaque partition derivation |
| `src/lib/cache.ts` | Separate public response headers from private external and inner edge policies |
| Route handlers | Accept a trusted storage context rather than deriving tenancy from caller input |
| Purge route | Authenticate as admin and purge the named private entrypoint's tags |
| Tests | Add token, partition-isolation, cache-bypass, CORS, and non-enumeration cases |

`PrivateLabels` should expose only a fetch handler needed by the gateway. If cache purge is scoped per entrypoint, expose a separate internal RPC method on the named entrypoint that calls its own `this.ctx.cache.purge({ tags })`; custom RPC methods bypass Workers Caching.

### 9.3 R2

R2 bucket bindings do not require a public bucket URL. For private deployments:

- Disable `r2.dev` access and do not attach a public custom domain.
- Rename `PUBLIC_LABELS` to `PRIVATE_LABELS`, or add a distinct binding for mixed deployments.
- Use a separate private bucket when public and private labels coexist.
- Remove `public` cache metadata from newly ingested private objects as defense in depth; the Worker must set final response policy explicitly.
- Scope ingestion credentials to the required bucket and operations.
- Preserve content metadata supplied by the uploader.
- For multi-tenancy, add the tenant prefix described in section 8.2.

The binding is the only runtime read path. There is no reason to give end users R2 credentials or signed R2 URLs.

### 9.4 Cache tags and invalidation

Retain tags, but make their security boundary explicit:

```text
private
private:labels
private:tenant:<opaque-id>
private:namespace:<safe-alias>
```

Data refresh flow:

1. Upload all replacement objects to R2.
2. Verify the upload manifest.
3. Purge the matching inner-cache tags through an authenticated admin path.
4. Confirm purge application and sample labels.

Auth policy changes generally do not require cached label bytes to be purged because the gateway re-authorizes every request. Bump `AUTHZ_POLICY_VERSION` when a change alters tenant-to-storage mapping or cache equivalence classes. That creates new cache partitions immediately; old entries expire or can be purged with `private`.

Keep cross-version caching disabled initially. The default version isolation prevents an old entry from being served after a security-relevant deployment. Enable it only after release and purge procedures account for auth and cache-key schema changes.

## 10. Variations of "normal auth"

The protocol shape matters more than the vendor name.

| Variation | Gateway behavior | Cache consequence |
|---|---|---|
| OIDC/OAuth JWT access token | Local JOSE validation with fixed issuer, audience, JWKS, time, and scopes | Recommended baseline |
| Multiple JWT issuers | Static issuer allowlist, separate validation and claim adapters | Partition includes issuer where data or subject domains differ |
| Cloudflare Access | Validate `Cf-Access-Jwt-Assertion` using team issuer and application audience | Same gateway pattern; Access policy is an additional outer check |
| Opaque OAuth access token | Call configured introspection endpoint and validate `active`, audience, expiry, scopes | Auth still runs each request; cache introspection only within revocation requirements |
| Auth proxy signed header | Trust only over a non-bypassable service binding, Tunnel, mTLS, or signed assertion | Never trust a plain public `X-User` header |
| Session cookie | Validate session and add CSRF protections where state-changing routes exist | External responses private; CORS and credential rules differ |
| API key/shared secret | Verify a hashed/rotatable key and map it to an access context | Suitable for limited service-to-service use, not preferred for users |
| mTLS/workload identity | Terminate and verify at a trusted gateway, then pass a signed identity context | Good service-to-service option |
| DPoP or sender-constrained token | Validate proof, request method/URL binding, nonce/replay rules | Gateway must run every request; never cache the proof decision as a response bypass |
| Signed capability URL | Validate signature and expiry before serving, with cache TTL no longer than capability lifetime | Separate mode with weaker revocation; not the default JWT design |

Provider-specific details should be isolated in adapters:

- Microsoft Entra ID commonly distinguishes delegated scopes (`scp`) from application roles (`roles`) and requires care with tenant-specific versus multi-tenant issuers.
- Amazon Cognito access tokens use provider-specific token-use and client claims.
- Auth0 and Okta require the correct custom authorization-server issuer and API audience, not merely the account's default login configuration.
- Google OAuth access tokens are not universally JWTs. A Google ID token is not automatically an access token for this API.
- Cloudflare Access uses its own application audience and `Cf-Access-Jwt-Assertion` header; Cloudflare recommends validating that assertion at the Worker/origin as well as applying Access policy.

These are configuration and claim-mapping differences. The cache boundary does not change.

## 11. CORS and browser clients

Sending `Authorization` cross-origin causes a browser preflight. The default gateway should:

- Handle `OPTIONS` without requiring a bearer token, because it returns no private label data.
- Allow only configured application origins.
- Return `Access-Control-Allow-Headers: Authorization, Content-Type`.
- Return `Access-Control-Allow-Methods: GET, OPTIONS`.
- Add `Vary: Origin` to external responses when origin varies.
- Add CORS headers after the inner cache response, so origin-specific headers are not stored in the shared private inner cache.
- Avoid `Access-Control-Allow-Origin: *` with credentialed cookie mode.

Bearer-token mode normally does not need `Access-Control-Allow-Credentials`; cookie-session and Cloudflare Access browser flows may need different configuration.

## 12. Operational behavior

### Observability

Log structured events without tokens or complete private IRIs:

- Authentication outcome and reason category.
- Trusted issuer identifier or configured issuer alias.
- Hashed subject or tenant identifier when needed for incident analysis.
- Authorization decision and policy version.
- Route, status, latency, and `Cf-Cache-Status` for the inner request.
- JWKS refresh success/failure and unknown `kid` counts.
- R2 hit/miss/error and purge result.

Do not log `Authorization`, cookies, JWT claims wholesale, or response bodies. Consider hashing the requested IRI if IRIs themselves are sensitive.

Metrics should distinguish gateway invocations from inner entrypoint misses. After rollout, every external private request should invoke the gateway, while most popular-label requests should avoid R2.

### Failure policy

| Failure | Behavior |
|---|---|
| Missing/invalid auth configuration | Fail deployment validation or return 503; never start open |
| IdP discovery/JWKS outage with known cached key | Continue validating with the still-valid cached key |
| Unknown `kid` and JWKS refresh failure | Fail closed |
| R2 failure on true cache miss | Return 503; do not expose internals |
| Purge failure after ingestion | Mark refresh incomplete and retry; old authorized bytes may remain |
| Policy store failure | Fail closed unless an explicitly bounded cached decision is part of the policy design |

Rate limits and abuse controls should run before expensive introspection or R2 work, but must not use attacker-controlled identity as a trusted key until validation succeeds.

## 13. Alternatives considered

### Keep the current front cache and add JWT validation to `handleLabel`

Rejected. A Workers Caching hit occurs before `handleLabel`, so validation is skipped.

### `Vary: Authorization`

Rejected. It partitions by raw credential, prevents useful sharing, and still lets a cache hit bypass current token validation.

### Disable Workers Caching and use `caches.default` after auth

Viable fallback, but not preferred. The Cache API is data-center local, does not support tiered caching through `cache.put`, and Cloudflare documents that it is unavailable for Workers fronted by Cloudflare Access. The per-entrypoint gateway provides the desired auth-first topology while retaining Workers Caching.

### Trust only Cloudflare Access and leave the current Worker cached

Conditionally viable for one deployment-wide access class if Access is guaranteed to cover every Worker hostname and preview route. It is less portable, makes origin validation difficult on cache hits, and is easy to weaken through an Access bypass rule. The proposed gateway still validates the Access assertion and therefore provides defense in depth.

### Put APIM, API Gateway, or another cloud gateway in front

Viable if the Worker origin cannot be reached around that gateway. Secure the origin with a service credential, mTLS, Tunnel, or equivalent. This can avoid implementing provider JWT details in the Worker, but introduces another deployed component, cost, and cache-order assumptions. Direct JWT validation remains the portable default.

### Signed URLs

Useful for temporary share links or clients unable to send headers. They are bearer capabilities, not normal user authentication. Their cache TTL must not exceed signature expiry, URLs may leak through logs and referrers, and revocation is weaker. Keep this as a separately selected mode.

## 14. Implementation and rollout plan

### Phase 1: Safe single-deployment JWT mode

1. Add `jose` and generated Worker types.
2. Add strict one-issuer JWT validation and `labels:read` authorization.
3. Split the default gateway from the cached `PrivateLabels` entrypoint.
4. Keep the current R2 key layout and use one constant private cache partition.
5. Protect label and private context routes.
6. Return private/no-store external cache headers as specified.
7. Add CORS allowlist support.
8. Make deployment validation fail when required auth variables are absent.

### Phase 2: Hardening

1. Rename or separate the R2 binding and verify that public bucket access is disabled.
2. Add authenticated inner-cache purge and policy-version partitioning.
3. Add structured logs, metrics, JWKS refresh monitoring, and rate limits.
4. Add end-to-end tests against deployed Workers Caching, because local emulation cannot prove edge cache ordering.
5. Document provider configuration examples for Entra ID, Auth0/Okta, Cognito, and Cloudflare Access.

### Phase 3: Optional policy models

1. Add multi-issuer configuration only with an explicit allowlist.
2. Add multi-tenant R2 prefixes and cache partitions.
3. Add opaque-token introspection if a target provider requires it.
4. Add per-namespace authorization only when a concrete policy-store requirement exists.

## 15. Test plan

Unit and Workers-runtime tests must cover:

- Valid token, wrong signature, wrong issuer, wrong audience, expired, future `nbf`, missing scope, unsupported algorithm, missing `kid`, and rotated key.
- A JWT payload that names an attacker-controlled issuer or JWKS URI.
- Access token versus ID token confusion.
- `401` versus `403`, `WWW-Authenticate`, and non-enumerating errors.
- Cache key canonicalization for equivalent URLs.
- No raw token, subject, email, or tenant value in the inner URL.
- Two tenants requesting the same IRI never sharing an R2 key or cache partition.
- Equivalent authorized users sharing the same deployment-wide cache entry.
- Auth failure never calling `PrivateLabels` or R2.
- CORS preflight and allowed/disallowed origins.
- Private external `Cache-Control` on 200 and 404 responses.
- Admin purge authentication and tag scope.

Deployed integration tests must prove:

1. A warm inner cache still causes the default auth gateway to run.
2. A valid token receives a cache `HIT` without an R2 read.
3. The same URL without a token receives `401`, never cached bytes.
4. A token in a different partition cannot receive the first partition's response.
5. Disabling auth or inner caching does not leave old cached private entries externally reachable.
6. Key rotation succeeds and unknown-key failure is closed.

## 16. Open questions

- Are private labels deployment-wide, tenant-wide, role-wide, or user-specific? This determines the cache partition.
- Which exact token issuer, audience, and authorization claim will the first deployment use?
- Must labels be removed from browser storage (`no-store`), or is private browser caching acceptable?
- Are IRIs themselves sensitive enough to require hashing in logs and analytics?
- Are namespace and JSON-LD context endpoints private, or can a generic public context remain on the public host?
- What JWT revocation window is acceptable? This sets maximum token lifetime and any introspection requirement.
- Does the first client run in a browser, a backend, or both? This determines CORS and token-acquisition documentation.
- Should public and private modes be separate deployment presets, or one mixed Worker with explicit entrypoints?

## 17. References

- [Cloudflare Workers Caching configuration and per-entrypoint gateway pattern](https://developers.cloudflare.com/workers/cache/configuration/)
- [Cloudflare Context API and `ctx.exports`](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Cloudflare Cache API limitations](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Access authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://datatracker.ietf.org/doc/html/rfc9068)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
