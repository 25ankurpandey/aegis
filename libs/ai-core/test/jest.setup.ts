// Ensure the auth secret exists before any test imports/exercises authenticate() (which does
// Config.require('AUTH_JWT_SECRET') at request time). Loaded via jest `setupFiles`.
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? 'test-secret';
