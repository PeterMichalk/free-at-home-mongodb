import { FreeAtHomeMongoDBAddon } from './addon';

async function main(): Promise<void> {
  console.log("free@home MongoDB Addon gestartet");

  const addon = new FreeAtHomeMongoDBAddon();
  await addon.tryLoadInitialConfiguration();

  console.log("free@home MongoDB Addon initialisiert");

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Beende Addon...');
    await addon.dispose();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Beende Addon...');
    await addon.dispose();
    process.exit(0);
  });
}

// Nur ausführen wenn direkt gestartet (nicht wenn als Modul importiert, z.B. in Tests)
if (require.main === module) {
  main().catch((error) => {
    console.error("Kritischer Fehler beim Starten des Addons:", error);
    process.exit(1);
  });
}
