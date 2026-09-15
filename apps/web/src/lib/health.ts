import { HealthStatusSchema } from '@uw/contracts';

export async function fetchHealth(fetcher: typeof fetch = fetch): Promise<'online' | 'offline'> {
  try {
    const response = await fetcher('/api/health/live');
    if (!response.ok) return 'offline';
    HealthStatusSchema.parse(await response.json());
    return 'online';
  } catch {
    return 'offline';
  }
}
