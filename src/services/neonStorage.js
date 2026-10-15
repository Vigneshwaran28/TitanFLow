import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

let client = null;

export function getStorageClient() {
  if (client) return client;
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || "ap-southeast-1";

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }

  client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true, // Required for Neon Object Storage wildcard TLS certificates
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return client;
}

export function isStorageConfigured() {
  return Boolean(getStorageClient());
}

export const DEFAULT_BUCKET = process.env.NEON_STORAGE_BUCKET || "assets";

/**
 * Upload an asset or file to Neon Object Storage
 */
export async function uploadAsset(key, body, contentType = "application/octet-stream", bucket = DEFAULT_BUCKET) {
  const s3 = getStorageClient();
  if (!s3) throw new Error("Neon Object Storage is not configured.");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return {
    bucket,
    key,
    url: `${process.env.AWS_ENDPOINT_URL_S3}/${bucket}/${key}`,
  };
}

/**
 * Retrieve an object from Neon Object Storage
 */
export async function getAsset(key, bucket = DEFAULT_BUCKET) {
  const s3 = getStorageClient();
  if (!s3) throw new Error("Neon Object Storage is not configured.");

  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return response.Body;
}

/**
 * Delete an object from Neon Object Storage
 */
export async function deleteAsset(key, bucket = DEFAULT_BUCKET) {
  const s3 = getStorageClient();
  if (!s3) throw new Error("Neon Object Storage is not configured.");

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return { ok: true };
}

/**
 * List objects in the bucket
 */
export async function listAssets(prefix = "", bucket = DEFAULT_BUCKET) {
  const s3 = getStorageClient();
  if (!s3) throw new Error("Neon Object Storage is not configured.");

  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    })
  );

  return response.Contents || [];
}

/**
 * Self-test proving Neon Object Storage works end-to-end
 */
export async function testStorageConnection(bucket = DEFAULT_BUCKET) {
  const s3 = getStorageClient();
  if (!s3) return { ok: false, error: "Storage credentials not found." };

  const testKey = `healthcheck/test-${Date.now()}.txt`;
  const testPayload = `Neon storage test: ${new Date().toISOString()}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: testKey,
      Body: testPayload,
      ContentType: "text/plain",
    })
  );

  const getRes = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: testKey,
    })
  );

  const content = await getRes.Body.transformToString();

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: testKey,
    })
  );

  if (content !== testPayload) {
    throw new Error("Neon storage verification mismatch: content read did not match written content.");
  }

  return { ok: true, bucket, verifiedAt: new Date().toISOString() };
}
