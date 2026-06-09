import { createApiClient } from '@erp/api-client';
import { getAccessToken } from './auth';

/**
 * The single typed API client for the web app (root CLAUDE.md §2). `baseUrl` already carries the
 * api's `/api` global prefix. All web→api calls go through this — never ad-hoc `fetch`.
 */
const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export const api = createApiClient(baseUrl, getAccessToken);
