import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { WorkerEnv } from '@integris/shared';

/**
 * MinIO reached with the worker's own key: read and write on the compilation buckets only
 * (compile-output, compile-cache). It has no right on the projects bucket: project files come as
 * presigned URLs in each job (docs/spec.md, "Réseau et pare-feu").
 */
export class WorkerStorage {
  private readonly s3: S3Client;

  constructor(
    env: Pick<WorkerEnv, 'MINIO_ENDPOINT' | 'MINIO_WORKER_ACCESS_KEY' | 'MINIO_WORKER_SECRET_KEY'>,
  ) {
    this.s3 = new S3Client({
      endpoint: env.MINIO_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.MINIO_WORKER_ACCESS_KEY,
        secretAccessKey: env.MINIO_WORKER_SECRET_KEY,
      },
    });
  }

  async put(bucket: string, key: string, body: Uint8Array, contentType: string, encoding?: string) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentEncoding: encoding,
      }),
    );
  }

  /** The object, or null when it does not exist. */
  async get(bucket: string, key: string, maxBytes: number): Promise<Buffer | null> {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body || (result.ContentLength ?? 0) > maxBytes) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  destroy(): void {
    this.s3.destroy();
  }
}
