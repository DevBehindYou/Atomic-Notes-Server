import '../src/lib/envGuard.js';
import app from '../src/app.js';

// Vercel Node.js Web Standard handler, required for MongoDB and Google SDKs.
export default { fetch: app.fetch };
