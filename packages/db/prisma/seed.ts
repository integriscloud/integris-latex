import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  parseEnv,
  PROJECTS_BUCKET,
  publicTemplateKey,
  seedEnvSchema,
  TEMPLATES_BUCKET,
} from '@integris/shared';
import { createPrismaClient } from '../src/client.js';
import { PLANS } from './seed-data/plans.js';
import { PUBLIC_TEMPLATES, zipTemplate } from './seed-data/templates.js';

// Initial data: the 4 plans, the public templates and the private buckets. Safe to run several
// times.
const env = parseEnv(seedEnvSchema, process.env);
const prisma = createPrismaClient(env.DATABASE_URL);
const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: env.MINIO_ROOT_USER, secretAccessKey: env.MINIO_ROOT_PASSWORD },
});

async function seedPlans(): Promise<void> {
  for (const plan of PLANS) {
    // Create missing plans only: values edited in the back-office are never overwritten.
    await prisma.plan.upsert({ where: { code: plan.code }, create: plan, update: {} });
  }
  console.log(`Plans: ${PLANS.length} ensured.`);
}

async function ensureBucket(bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'NotFound') throw error;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function seedTemplates(): Promise<void> {
  await ensureBucket(TEMPLATES_BUCKET);
  for (const template of PUBLIC_TEMPLATES) {
    const storageKey = publicTemplateKey(template.slug);
    await s3.send(
      new PutObjectCommand({
        Bucket: TEMPLATES_BUCKET,
        Key: storageKey,
        Body: zipTemplate(template.slug),
        ContentType: 'application/zip',
      }),
    );
    const data = {
      scope: 'PUBLIC',
      name: template.name,
      description: template.description,
      category: template.category,
      isPublished: true,
    } as const;
    await prisma.template.upsert({
      where: { storageKey },
      create: { ...data, storageKey },
      update: data,
    });
  }
  console.log(`Templates: ${PUBLIC_TEMPLATES.length} uploaded to "${TEMPLATES_BUCKET}".`);
}

try {
  await seedPlans();
  await seedTemplates();
  await ensureBucket(PROJECTS_BUCKET);
  console.log(`Bucket "${PROJECTS_BUCKET}" ensured.`);
} finally {
  await prisma.$disconnect();
  s3.destroy();
}
