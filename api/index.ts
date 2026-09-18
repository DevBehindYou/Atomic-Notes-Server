import '../src/lib/envGuard';
import app from '../src/app';

// Vercel Node.js Web Standard handler, required for MongoDB and Google SDKs.
export default { fetch: app.fetch };
