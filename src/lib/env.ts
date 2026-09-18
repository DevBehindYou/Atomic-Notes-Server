export type EnvIssue = { name: string; problem: string };

/**
 * Configuration problems, by variable name. Values are never included, so the
 * result is safe to log or return to the admin health check.
 */
export function getEnvIssues(env: NodeJS.ProcessEnv = process.env): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const missing = (name: string) => { if (!env[name]?.trim()) { issues.push({ name, problem: 'not set' }); return true; } return false; };

  if (!missing('MONGODB_URI') && !/^mongodb(\+srv)?:\/\//.test(env.MONGODB_URI!)) {
    issues.push({ name: 'MONGODB_URI', problem: 'must start with mongodb:// or mongodb+srv://' });
  }
  if (!missing('TOKEN_ENCRYPTION_KEY') && Buffer.from(env.TOKEN_ENCRYPTION_KEY!, 'base64').length !== 32) {
    issues.push({ name: 'TOKEN_ENCRYPTION_KEY', problem: 'must be base64 that decodes to exactly 32 bytes' });
  }
  missing('GOOGLE_CLIENT_ID');
  missing('GOOGLE_CLIENT_SECRET');
  if (!missing('GOOGLE_REDIRECT_URI') && !/^https:\/\/[^\s/]+\/api\/auth\/callback$/.test(env.GOOGLE_REDIRECT_URI!)) {
    issues.push({ name: 'GOOGLE_REDIRECT_URI', problem: 'must be an https URL ending in /api/auth/callback' });
  }
  if (!missing('ADMIN_API_KEY') && Buffer.byteLength(env.ADMIN_API_KEY!) < 32) {
    issues.push({ name: 'ADMIN_API_KEY', problem: 'must contain at least 32 bytes' });
  }
  return issues;
}

/** Stops a production cold start with an unusable configuration instead of failing per request. */
export function assertProductionEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV !== 'production' && env.NODE_ENV !== 'production') return;
  const issues = getEnvIssues(env);
  if (issues.length) {
    throw new Error(`Invalid Server configuration: ${issues.map((issue) => `${issue.name} ${issue.problem}`).join('; ')}`);
  }
}
