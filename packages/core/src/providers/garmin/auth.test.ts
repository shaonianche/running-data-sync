import type { GarminMfaRequiredError, GarminOAuth1Token, GarminOAuth2Token, GarminOAuthConsumer } from './types.js'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { ConfigurationError } from '../../foundation/index.js'
import {
  clearOAuthConsumerCache,
  deserializeGarminSecret,
  exchangeOAuth1ForOAuth2,
  formatOAuth2AuthorizationHeader,
  getGarminSecret,
  getGarminUrls,
  isOAuth2TokenExpired,
  loginGarmin,
  resolveGarminAccount,
  resolveGarminDomain,
  serializeGarminSecret,
} from './auth.js'
import { createOAuth1AuthorizationHeader, percentEncode } from './oauth1.js'
import { GarminAuthenticationError } from './types.js'

const TEST_CONSUMER: GarminOAuthConsumer = {
  consumer_key: 'test-consumer-key',
  consumer_secret: 'test-consumer-secret',
}

function createGarthFixture(overrides: {
  oauth1?: Partial<GarminOAuth1Token>
  oauth2?: Partial<GarminOAuth2Token>
} = {}): {
  oauth1: GarminOAuth1Token
  oauth2: GarminOAuth2Token
  secretString: string
} {
  const oauth1: GarminOAuth1Token = {
    oauth_token: 'oauth1-token-fixture-abc',
    oauth_token_secret: 'oauth1-secret-fixture-xyz',
    mfa_token: null,
    mfa_expiration_timestamp: null,
    domain: 'garmin.com',
    ...overrides.oauth1,
  }
  const oauth2: GarminOAuth2Token = {
    scope: 'CONNECT_READ CONNECT_WRITE',
    jti: 'jti-123',
    token_type: 'bearer',
    access_token: 'oauth2-access-token-fixture',
    refresh_token: 'oauth2-refresh-token-fixture',
    expires_in: 3600,
    expires_at: 2_000_000_000,
    refresh_token_expires_in: 86400,
    refresh_token_expires_at: 2_000_086_400,
    ...overrides.oauth2,
  }
  return {
    oauth1,
    oauth2,
    secretString: Buffer.from(JSON.stringify([oauth1, oauth2]), 'utf8').toString('base64'),
  }
}

describe('garmin OAuth1 HMAC-SHA1 signing', () => {
  it('matches the official RFC 5849 Section 1.2 signature vector', () => {
    const header = createOAuth1AuthorizationHeader({
      method: 'GET',
      url: 'http://photos.example.net/photos?file=vacation.jpg&size=original',
      consumerKey: 'dpf43f3p2l4k3l03',
      consumerSecret: 'kd94hf93k423kf44',
      token: 'nnch734d00sl2jdk',
      tokenSecret: 'pfkkdhi9sl3r4s00',
      timestamp: '1191242096',
      nonce: 'kllo9940pd9333jh',
    })

    expect(header).toContain(`oauth_signature="${percentEncode('tR3+Ty81lMeYAr/Fid0kMTYa/WM=')}"`)
    expect(header).toContain('oauth_consumer_key="dpf43f3p2l4k3l03"')
    expect(header).toContain('oauth_token="nnch734d00sl2jdk"')
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"')
    expect(header).toContain('oauth_version="1.0"')
  })

  it('omits oauth_token when signing preauthorized ticket exchange requests', () => {
    const header = createOAuth1AuthorizationHeader({
      method: 'GET',
      url: 'https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=ST-123&accepts-mfa-tokens=true',
      consumerKey: TEST_CONSUMER.consumer_key,
      consumerSecret: TEST_CONSUMER.consumer_secret,
      timestamp: '1700000000',
      nonce: 'nonce123',
    })

    expect(header.startsWith('OAuth ')).toBe(true)
    expect(header).not.toContain('oauth_token=')
    expect(header).toContain('oauth_signature=')
  })
})

describe('garmin garth secret_string compatibility & domain resolution', () => {
  it('resolves COM and CN domains, accounts, and URLs cleanly', () => {
    expect(resolveGarminDomain(false)).toBe('garmin.com')
    expect(resolveGarminDomain('COM')).toBe('garmin.com')
    expect(resolveGarminDomain(true)).toBe('garmin.cn')
    expect(resolveGarminDomain('CN')).toBe('garmin.cn')
    expect(resolveGarminDomain('garmin.cn')).toBe('garmin.cn')

    expect(resolveGarminAccount(false)).toBe('garmin_com')
    expect(resolveGarminAccount(true)).toBe('garmin_cn')

    const cnUrls = getGarminUrls(true)
    expect(cnUrls.ssoOrigin).toBe('https://sso.garmin.cn')
    expect(cnUrls.modernBase).toBe('https://connectapi.garmin.cn')
    expect(cnUrls.uploadUrl).toBe('https://connectapi.garmin.cn/upload-service/upload/')
  })

  it('deserializes garth.client.dumps() COM and CN payloads and round-trips cleanly', () => {
    const comFixture = createGarthFixture()
    const parsedCom = deserializeGarminSecret(comFixture.secretString)
    expect(parsedCom.domain).toBe('garmin.com')
    expect(parsedCom.oauth1Token).toEqual(comFixture.oauth1)
    expect(parsedCom.oauth2Token).toEqual(comFixture.oauth2)
    expect(formatOAuth2AuthorizationHeader(parsedCom.oauth2Token)).toBe('Bearer oauth2-access-token-fixture')
    expect(isOAuth2TokenExpired(parsedCom.oauth2Token, 1_900_000_000_000)).toBe(false)
    expect(isOAuth2TokenExpired(parsedCom.oauth2Token, 2_000_000_001_000)).toBe(true)

    const cnFixture = createGarthFixture({
      oauth1: { domain: 'garmin.cn', mfa_token: 'mfa-xyz' },
    })
    const parsedCn = deserializeGarminSecret(cnFixture.secretString)
    expect(parsedCn.domain).toBe('garmin.cn')
    expect(parsedCn.oauth1Token.mfa_token).toBe('mfa-xyz')

    const reserialized = serializeGarminSecret(parsedCn.oauth1Token, parsedCn.oauth2Token)
    expect(deserializeGarminSecret(reserialized)).toEqual(parsedCn)
  })

  it('rejects malformed or incomplete secret strings', () => {
    expect(() => deserializeGarminSecret('')).toThrow(GarminAuthenticationError)
    expect(() => deserializeGarminSecret('not-json-base64!!!')).toThrow(GarminAuthenticationError)
    const missingToken = Buffer.from(JSON.stringify([{ oauth_token: 'a' }, {}]), 'utf8').toString('base64')
    expect(() => deserializeGarminSecret(missingToken)).toThrow(GarminAuthenticationError)
  })
})

describe('garmin OAuth2 exchange and SSO login', () => {
  it('exchanges OAuth1 token for OAuth2 token on COM and CN with signed form body', async () => {
    clearOAuthConsumerCache()
    const calls: Array<{ url: string, method: string, auth: string, body: string }> = []

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        auth: headers.get('authorization') ?? '',
        body: typeof init?.body === 'string' ? init.body : '',
      })
      return new Response(
        JSON.stringify({
          scope: 'CONNECT_READ',
          jti: 'fresh-jti',
          token_type: 'bearer',
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 7200,
          refresh_token_expires_in: 86400,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const { oauth1 } = createGarthFixture({
      oauth1: { domain: 'garmin.cn', mfa_token: 'mfa-secret-123' },
    })

    const token = await exchangeOAuth1ForOAuth2({
      oauth1Token: oauth1,
      domain: 'garmin.cn',
      isLogin: true,
      fetch: mockFetch,
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://connectapi.garmin.cn/oauth-service/oauth/exchange/user/2.0')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.auth).toMatch(/^OAuth /)
    expect(calls[0]?.body).toContain('audience=GARMIN_CONNECT_MOBILE_ANDROID_DI')
    expect(calls[0]?.body).toContain('mfa_token=mfa-secret-123')
    expect(token.access_token).toBe('fresh-access-token')
    expect(token.expires_at).toBe(1_700_007_200)
    expect(token.refresh_token_expires_at).toBe(1_700_086_400)
  })

  it('completes SSO login for both COM and CN and produces a garth-compatible secret_string', async () => {
    for (const isCn of [false, true]) {
      const expectedDomain = isCn ? 'garmin.cn' : 'garmin.com'
      const seenUrls: string[] = []
      const seenCookies: Array<string | null> = []

      const mockFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers = new Headers(init?.headers)
        seenUrls.push(url)
        seenCookies.push(headers.get('cookie'))

        if (url.includes('/mobile/sso/en/sign-in')) {
          return new Response('<html>sign-in</html>', {
            status: 200,
            headers: { 'set-cookie': 'SESSIONID=sso-cookie-1; Path=/; HttpOnly' },
          })
        }
        if (url.includes('/mobile/api/login')) {
          return new Response(
            JSON.stringify({
              responseStatus: { type: 'SUCCESSFUL' },
              serviceTicketId: 'ST-TICKET-999',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/portal/sso/embed')) {
          return new Response('<html>embed</html>', { status: 200 })
        }
        if (url.includes('/oauth-service/oauth/preauthorized')) {
          expect(headers.get('authorization')).toMatch(/^OAuth /)
          return new Response('oauth_token=o1-tok&oauth_token_secret=o1-sec', { status: 200 })
        }
        if (url.includes('/oauth-service/oauth/exchange/user/2.0')) {
          return new Response(
            JSON.stringify({
              scope: 'CONNECT',
              jti: 'jti-login',
              token_type: 'bearer',
              access_token: 'o2-access',
              refresh_token: 'o2-refresh',
              expires_in: 3600,
              refresh_token_expires_in: 86400,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('Not Found', { status: 404 })
      }

      const secret = await getGarminSecret({
        email: 'runner@example.com',
        password: 'super-secret-password',
        isCn,
        fetch: mockFetch,
        oauthConsumer: TEST_CONSUMER,
        now: () => 1_700_000_000_000,
      })

      expect(seenUrls[0]).toContain(`https://sso.${expectedDomain}/mobile/sso/en/sign-in`)
      expect(seenUrls[1]).toContain(`https://sso.${expectedDomain}/mobile/api/login`)
      expect(seenCookies[1]).toContain('SESSIONID=sso-cookie-1')
      expect(seenUrls.some(u => u.startsWith(`https://connectapi.${expectedDomain}/oauth-service/oauth/preauthorized`))).toBe(true)
      expect(seenUrls.includes(`https://connectapi.${expectedDomain}/oauth-service/oauth/exchange/user/2.0`)).toBe(true)

      const bundle = deserializeGarminSecret(secret)
      expect(bundle.domain).toBe(expectedDomain)
      expect(bundle.oauth1Token.oauth_token).toBe('o1-tok')
      expect(bundle.oauth2Token.access_token).toBe('o2-access')
    }
  })

  it('raises GarminMfaRequiredError when MFA is needed without a code, and completes login when promptMfa supplies one', async () => {
    const createMfaFetch = (): typeof fetch => async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/mobile/sso/en/sign-in')) {
        return new Response('ok', { status: 200 })
      }
      if (url.includes('/mobile/api/login')) {
        return new Response(
          JSON.stringify({
            responseStatus: { type: 'MFA_REQUIRED' },
            customerMfaInfo: { mfaLastMethodUsed: 'sms' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/mobile/api/mfa/verifyCode')) {
        return new Response(
          JSON.stringify({
            responseStatus: { type: 'SUCCESSFUL' },
            serviceTicketId: 'ST-MFA-TICKET',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/portal/sso/embed')) {
        return new Response('ok', { status: 200 })
      }
      if (url.includes('/oauth/preauthorized')) {
        return new Response('oauth_token=mfa-o1&oauth_token_secret=mfa-sec&mfa_token=mfa-tok', { status: 200 })
      }
      if (url.includes('/oauth/exchange/user/2.0')) {
        return new Response(
          JSON.stringify({
            scope: 'CONNECT',
            jti: 'jti-mfa',
            token_type: 'bearer',
            access_token: 'mfa-o2',
            refresh_token: 'mfa-ref',
            expires_in: 3600,
            refresh_token_expires_in: 86400,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }

    await expect(
      loginGarmin({
        email: 'runner@example.com',
        password: 'secret-password',
        fetch: createMfaFetch(),
        oauthConsumer: TEST_CONSUMER,
      }),
    ).rejects.toMatchObject({
      name: 'GarminMfaRequiredError',
      mfaMethod: 'sms',
    } satisfies Partial<GarminMfaRequiredError>)

    const promptedMethods: string[] = []
    const result = await loginGarmin({
      email: 'runner@example.com',
      password: 'secret-password',
      promptMfa: async (method) => {
        promptedMethods.push(method)
        return '654321'
      },
      fetch: createMfaFetch(),
      oauthConsumer: TEST_CONSUMER,
    })

    expect(promptedMethods).toEqual(['sms'])
    expect(result.oauth1Token.mfa_token).toBe('mfa-tok')
    expect(result.oauth2Token.access_token).toBe('mfa-o2')
  })

  it('throws ConfigurationError when email or password is missing from options and env', async () => {
    await expect(
      getGarminSecret({
        envOptions: { processEnv: {}, envFilePath: '/nonexistent/.env.local' },
      }),
    ).rejects.toThrow(ConfigurationError)
  })
})
