import { handleProxy, type ProxyEnv } from './functions/api/proxy'

export interface Env extends ProxyEnv {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>
  }
  // Basic Auth 凭据，在 wrangler.jsonc vars 中配置；任一未设置时关闭鉴权
  AUTH_USERNAME?: string
  AUTH_PASSWORD?: string
}

function isAuthorized(request: Request, env: Env): boolean {
  const user = env.AUTH_USERNAME
  const pass = env.AUTH_PASSWORD
  if (!user || !pass) return true // 未配置则不启用密码保护
  const header = request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Basic ')) return false
  let decoded = ''
  try {
    decoded = atob(header.slice(6).trim())
  } catch {
    return false
  }
  const idx = decoded.indexOf(':')
  return idx >= 0 && decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass
}

function unauthorized(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="AI Pose Gallery", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 全站访问密码（含静态资源与 API）
    if (!isAuthorized(request, env)) return unauthorized()

    const url = new URL(request.url)

    // Handle /api/proxy CORS forwarding for DashScope (Qwen) & Volcengine Ark (Doubao)
    if (url.pathname === '/api/proxy') {
      if (request.method === 'POST' || request.method === 'GET') {
        return handleProxy({ request, env })
      }
      return new Response(JSON.stringify({ error: { message: 'Method Not Allowed' } }), {
        status: 405,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
    }

    // Fallback to static assets binding
    return env.ASSETS.fetch(request)
  },
}
