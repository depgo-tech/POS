import { onRequestPost } from './functions/api/[[route]].js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      return onRequestPost({ request: request, env: env, params: { route: [parts[1] || ''] }, data: {} });
    }
    return env.ASSETS.fetch(request);
  }
};
