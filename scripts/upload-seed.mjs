#!/usr/bin/env node
// Upload the ingest manifest (dist/seed/manifest.ndjson) to R2 via the S3 API.
//
// Bulk seeding for a real deployment — see scripts/seed-local.sh for the slow,
// dev-only miniflare path. Objects are PUT concurrently; keys are the exact
// strings from the manifest (case-sensitive, so schema/Text and schema/text
// stay distinct).
//
// Env (from GitHub Actions secrets, never inlined):
//   R2_ACCOUNT_ID         Cloudflare account id (→ S3 endpoint host)
//   R2_ACCESS_KEY_ID      R2 API token access key id
//   R2_SECRET_ACCESS_KEY  R2 API token secret
//   R2_BUCKET             bucket name (default: rdf-public-labels)
//   CONCURRENCY           parallel PUTs (default: 32)
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "dist", "seed", "manifest.ndjson");

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET = "rdf-public-labels",
  CONCURRENCY = "32",
} = process.env;

// Fail fast: report every missing credential at once, not one per run.
const missing = Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(", ")} (from a Cloudflare R2 API token)`);
  process.exit(1);
}

const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`;
const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, region: "auto", service: "s3" });

async function putObject(key, body) {
  const url = `${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const res = await aws.fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/ld+json", "Cache-Control": "public, max-age=86400" },
  });
  if (!res.ok) throw new Error(`PUT ${key} → ${res.status} ${await res.text().catch(() => "")}`);
}

async function main() {
  const records = (await readFile(MANIFEST, "utf8"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const conc = Math.max(1, Number(CONCURRENCY) || 32);
  console.log(`Uploading ${records.length} objects → ${R2_BUCKET} (concurrency ${conc})`);

  let next = 0, done = 0, failed = 0;
  async function worker() {
    while (next < records.length) {
      const { key, body } = records[next++];
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
