import 'reflect-metadata';
import { loadServiceEnv, Logger } from '@aegis/service-core';

// Thin entrypoint (the donor index → bootstrap split): init reflect-metadata + the logger, then hand
// off to the composition root in bootstrap.ts.
loadServiceEnv('expense');
Logger.init('expense');
import('./bootstrap');
