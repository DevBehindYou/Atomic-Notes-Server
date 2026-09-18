import { assertProductionEnvironment } from './env.js';

// Imported first by the Vercel entrypoint, so it runs before modules that read
// the environment (the MongoDB client throws on import when MONGODB_URI is unset).
assertProductionEnvironment();
