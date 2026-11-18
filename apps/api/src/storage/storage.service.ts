import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';

/**
 * Private object storage (MinIO) reached with the API's own access key. Nothing stored here is
 * ever served directly to a browser: user content goes out through the files subdomain later.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly s3: S3Client;

  constructor(config: ApiConfig) {
    const { env } = config;
    this.s3 = new S3Client({
      endpoint: env.MINIO_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.MINIO_API_ACCESS_KEY,
        secretAccessKey: env.MINIO_API_SECRET_KEY,
      },
    });
  }

  async put(bucket: string, key: string, body: Uint8Array): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
      }),
    );
  }

  /** Copies an object inside the bucket, without going through the API. */
  async copy(bucket: string, from: string, to: string): Promise<void> {
    await this.s3.send(
      new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from}` }),
    );
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error(`Empty object ${bucket}/${key}`);
    return result.Body.transformToByteArray();
  }

  async deleteKeys(bucket: string, keys: string[]): Promise<void> {
    // DeleteObjects accepts at most 1000 keys per call.
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async deletePrefix(bucket: string, prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
      if (keys.length) await this.deleteKeys(bucket, keys);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }
}
