/** Every declared route, in registration order. */

import { BULK_ROUTES } from './bulk.js';
import { CORE_ROUTES } from './core.js';
import { DOCS_ROUTES } from './docs.js';
import { SERVICE_ROUTES } from './services.js';
import type { Route } from './types.js';

export const ALL_ROUTES: readonly Route[] = [...CORE_ROUTES, ...SERVICE_ROUTES, ...DOCS_ROUTES, ...BULK_ROUTES];
