import { handleProxy, type ProxyEnv } from './functions/api/proxy'

export interface Env extends ProxyEnv {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>
  }
  // Basic Auth 凭据，在 wrangler.jsonc vars 中配置；任一未设置时关闭鉴权
  AUTH_USERNAME?: string
  AUTH_PASSWORD?: string
}

const COOKIE_NAME = 'gallery_auth'
const COOKIE_MAX_AGE = 30 * 24 * 3600 // 会话有效期：30 天

function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 从站点密码派生 HMAC 密钥：改密码会使所有已发会话 Cookie 立即失效
const hmacKeys = new Map<string, Promise<CryptoKey>>()
function getHmacKey(password: string): Promise<CryptoKey> {
  let key = hmacKeys.get(password)
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('gallery-auth-v1:' + password),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    hmacKeys.set(password, key)
  }
  return key
}

async function makeSessionToken(password: string): Promise<string> {
  const exp = Date.now() + COOKIE_MAX_AGE * 1000
  const payload = String(exp)
  const sig = await crypto.subtle.sign('HMAC', await getHmacKey(password), new TextEncoder().encode(payload))
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`
}

async function verifySessionToken(token: string, password: string): Promise<boolean> {
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const payload = token.slice(0, dot)
  const exp = Number(payload)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const key = await getHmacKey(password)
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  // 常数时间比较签名，避免时序侧信道
  const a = b64urlEncode(new Uint8Array(expected))
  const b = token.slice(dot + 1)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

/**
 * 校验访问身份：
 * - 'ok'       会话 Cookie 有效（或鉴权未启用），直接放行
 * - 'basic-ok' Basic 凭据有效（通常是浏览器首次登录的自动重试），放行并下发会话 Cookie
 * - 'fail'     未通过，返回 401
 *
 * 注意：不能只认 Authorization 头——前端调用 /api/proxy 时会把 AI 服务的
 * API Key 放在 Authorization: Bearer 里，与站点 Basic Auth 冲突，所以登录
 * 成功后必须改用 Cookie 会话，把 Authorization 头留给 AI 密钥。
 */
async function checkAuth(request: Request, env: Env): Promise<'ok' | 'basic-ok' | 'fail'> {
  const user = env.AUTH_USERNAME
  const pass = env.AUTH_PASSWORD
  if (!user || !pass) return 'ok' // 未配置则不启用密码保护

  const session = getCookie(request, COOKIE_NAME)
  if (session && (await verifySessionToken(session, pass))) return 'ok'

  const header = request.headers.get('Authorization') ?? ''
  if (header.startsWith('Basic ')) {
    let decoded = ''
    try {
      decoded = atob(header.slice(6).trim())
    } catch {
      return 'fail'
    }
    const idx = decoded.indexOf(':')
    if (idx >= 0 && decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) {
      return 'basic-ok'
    }
  }
  return 'fail'
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
    // 全站访问密码（含静态资源与 API），登录成功后以 Cookie 会话保持
    const auth = await checkAuth(request, env)
    if (auth === 'fail') return unauthorized()

    const url = new URL(request.url)
    let response: Response

    // Handle /api/proxy CORS forwarding for DashScope (Qwen) & Volcengine Ark (Doubao)
    if (url.pathname === '/api/proxy') {
      if (request.method === 'POST' || request.method === 'GET') {
        response = await handleProxy({ request, env })
      } else {
        response = new Response(JSON.stringify({ error: { message: 'Method Not Allowed' } }), {
          status: 405,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      }
    } else {
      // Fallback to static assets binding
      response = await env.ASSETS.fetch(request)
    }

    // Basic 登录成功（首次或 Cookie 过期后的自动重试）时下发新会话 Cookie
    if (auth === 'basic-ok' && env.AUTH_PASSWORD) {
      const token = await makeSessionToken(env.AUTH_PASSWORD)
      response = new Response(response.body, response)
      response.headers.append(
        'Set-Cookie',
        `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`,
      )
    }
    return response
  },
}
