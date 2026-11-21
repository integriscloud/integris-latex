import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  COMPILE_CACHE_BUCKET,
  COMPILE_OUTPUT_BUCKET,
  EXAM_PAPERS_BUCKET,
  parseEnv,
  planTermsOf,
  PROJECTS_BUCKET,
  publicTemplateKey,
  RECEIPTS_BUCKET,
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
    const row = await prisma.plan.upsert({ where: { code: plan.code }, create: plan, update: {} });
    // Version 1 of a new plan (step 14): the history of the back-office changes starts here.
    // Checked first: the table is append-only, so even an empty upsert update is refused.
    const first = { planId_version: { planId: row.id, version: 1 } };
    if (!(await prisma.planRevision.findUnique({ where: first }))) {
      await prisma.planRevision.create({
        data: {
          id: `rev1_${row.id}`,
          planId: row.id,
          version: 1,
          terms: planTermsOf(row),
          reason: 'initial',
        },
      });
    }
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

/** Receipt numbering (step 11): the counter row, created by the migration too. */
async function seedBilling(): Promise<void> {
  await prisma.billingCounter.upsert({
    where: { id: 'receipt' },
    create: { id: 'receipt', value: 0 },
    update: {},
  });
  // A test promo code on development servers only; real codes come from the back-office.
  if (process.env.NODE_ENV !== 'production') {
    await prisma.promoCode.upsert({
      where: { code: 'DEV10' },
      create: { code: 'DEV10', percentOff: 10 },
      update: {},
    });
    console.log('Promo code DEV10 (10 %, development only) ensured.');
  }
}

try {
  await seedPlans();
  await seedTemplates();
  await seedBilling();
  for (const bucket of [
    PROJECTS_BUCKET,
    COMPILE_OUTPUT_BUCKET,
    COMPILE_CACHE_BUCKET,
    RECEIPTS_BUCKET,
    EXAM_PAPERS_BUCKET,
  ]) {
    await ensureBucket(bucket);
    console.log(`Bucket "${bucket}" ensured.`);
  }
} finally {
  await prisma.$disconnect();
  s3.destroy();
}
