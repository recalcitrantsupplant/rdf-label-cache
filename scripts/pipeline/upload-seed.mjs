#!/usr/bin/env node
// Upload the ingest manifest (dist/seed/manifest.ndjson) to R2 via the S3 API.
//
// Bulk seeding for a real deployment - see scripts/ops/seed-local.sh for the slow,
// dev-only miniflare path. Objects are PUT concurrently; keys are the exact
// strings from the manifest (case-sensitive, so schema/Text and schema/text
// stay distinct).
//
// Env (from GitHub Actions secrets, never inlined):
//   CLOUDFLARE_ACCOUNT_ID Cloudflare account id (→ S3 endpoint host)
//   R2_ACCESS_KEY_ID      R2 API token access key id
//   R2_SECRET_ACCESS_KEY  R2 API token secret
//   R2_BUCKET             bucket name, e.g. label-cache-<project>
//   CONCURRENCY           parallel PUTs (default: 32)
//   FORCE_CONTEXT         PRE-RELEASE ESCAPE HATCH. Truthy = overwrite an existing
//                         context/labels-v1.json in place even when it changed,
//                         instead of refusing. Safe only while no consumer has
//                         pinned the URL; once public, bump to -v2 and NEVER force.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(ROOT, "dist", "seed", "manifest.ndjson");

const {
  CLOUDFLARE_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  CONCURRENCY = "32",
} = process.env;

// Pre-release only: allow overwriting the "immutable" context in place. Off by
// default so the guard below stays the norm.
const FORCE_CONTEXT = /^(1|true|yes)$/i.test(process.env.FORCE_CONTEXT ?? "");

// Fail fast: report every missing value at once, not one per run. R2_BUCKET is
// explicit (no default) so uploads always target the same bucket the Worker is
// bound to — per project, that's label-cache-<project>.
const missing = Object.entries({ CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(", ")} (CLOUDFLARE_ACCOUNT_ID is your Cloudflare account id; R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY from a Cloudflare R2 API token; R2_BUCKET is your bucket name, e.g. label-cache-<project>)`);
  process.exit(1);
}

const endpoint = `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`;
const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, region: "auto", service: "s3" });

function objectUrl(key) {
  return `${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function putObject(key, body) {
  const res = await aws.fetch(objectUrl(key), {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/ld+json", "Cache-Control": "public, max-age=86400" },
  });
  if (!res.ok) throw new Error(`PUT ${key} → ${res.status} ${await res.text().catch(() => "")}`);
}

async function ensureImmutableContext(record) {
  const res = await aws.fetch(objectUrl(record.key));
  if (res.status === 404) {
    await putObject(record.key, record.body);
    console.log(`Published new immutable context: ${record.key}`);
    return;
  }
  if (!res.ok) throw new Error(`GET ${record.key} → ${res.status} ${await res.text().catch(() => "")}`);
  if ((await res.text()) !== record.body) {
    if (FORCE_CONTEXT) {
      await putObject(record.key, record.body);
      console.warn(`⚠ FORCE_CONTEXT: overwrote ${record.key} in place. Only safe pre-release - bump to a new version (-v2) once the URL is pinned by consumers.`);
      return;
    }
    throw new Error(
      `Refusing to overwrite immutable context ${record.key}. Publish a new context version and regenerate labels instead. (Pre-release: set FORCE_CONTEXT=1 to overwrite in place.)`
    );
  }
  console.log(`Verified immutable context: ${record.key}`);
}

async function main() {
  const records = (await readFile(MANIFEST, "utf8"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const context = records.find((record) => record.key === "context/labels-v1.json");
  if (!context) throw new Error("Manifest does not contain context/labels-v1.json");
  await ensureImmutableContext(context);

  const labelRecords = records.filter((record) => record !== context);
  const conc = Math.max(1, Number(CONCURRENCY) || 32);
  console.log(`Uploading ${labelRecords.length} label objects → ${R2_BUCKET} (concurrency ${conc})`);

  let next = 0, done = 0, failed = 0;
  async function worker() {
    while (next < labelRecords.length) {
      const { key, body } = labelRecords[next++];
      try {
        await putObject(key, body);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${e.message}`);
      }
      if (++done % 250 === 0) console.log(`  ${done}/${records.length}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  console.log(`Done: ${done - failed} uploaded, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
