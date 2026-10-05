import { buildApp } from './app';
import { createContext, ensureAdmin, startWorkers, stopWorkers } from './context';
import { loadEnv } from './env';

async function main() {
  const env = loadEnv();
  const ctx = await createContext(env);
  await ensureAdmin(ctx);
  const app = await buildApp(ctx);
  if (env.WORKERS !== false) await startWorkers(ctx);

  await app.listen({ host: env.HOST, port: env.PORT });
  ctx.log.info(
    {
      url: env.APP_URL,
      payment: ctx.hardware.payment.name,
      camera: ctx.settings.get().camera.driver,
      robot: ctx.settings.get().robot.driver,
      printer: ctx.settings.get().printer.driver,
      storage: env.STORAGE_PROVIDER,
    },
    `Robot Photobooth server ready — booth ${env.APP_URL}/  admin ${env.APP_URL}/admin/`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15000);
    try {
      await app.close();
      await stopWorkers(ctx);
      await ctx.prisma.$disconnect();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => ctx.log.error({ err }, 'unhandled_rejection'));
  process.on('uncaughtException', (err) => {
    ctx.log.fatal({ err }, 'uncaught_exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
