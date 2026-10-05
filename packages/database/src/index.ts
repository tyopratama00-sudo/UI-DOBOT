import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __photoboothPrisma?: PrismaClient };

export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

/** Process-wide singleton (avoids exhausting connections during hot reload). */
export const prisma: PrismaClient = globalForPrisma.__photoboothPrisma ?? createPrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.__photoboothPrisma = prisma;
