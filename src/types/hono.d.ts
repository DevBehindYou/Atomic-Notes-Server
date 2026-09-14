import 'hono';

// requireAuth supplies these values before authenticated route handlers run.
declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    sessionToken: string;
  }
}
