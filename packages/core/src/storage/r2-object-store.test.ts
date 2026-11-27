import type { S3LikeClient } from './r2-object-store.js'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { PreconditionFailedError } from '../contracts/object-store.js'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import { buildR2Endpoint, R2ObjectStore } from './r2-object-store.js'

function createMockClient(
  handler: (command: unknown) => Promise<unknown>,
): { client: S3LikeClient, send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(handler)
  return {
    client: { send },
    send,
  }
}

describe('r2ObjectStore', () => {
  it('builds the Cloudflare R2 S3 endpoint from accountId', () => {
    expect(buildR2Endpoint('acc123')).toBe('https://acc123.r2.cloudflarestorage.com')
    expect(() => buildR2Endpoint('   ')).toThrow(ConfigurationError)
  })

  it('validates required environment variables in fromEnv', () => {
    expect(() => R2ObjectStore.fromEnv({})).toThrow(ConfigurationError)
    expect(() =>
      R2ObjectStore.fromEnv({
        R2_ACCOUNT_ID: 'acc123',
        R2_BUCKET: 'private-bucket',
      }),
    ).toThrow(/R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/)

    const store = R2ObjectStore.fromEnv({
      R2_ACCOUNT_ID: 'acc123',
      R2_BUCKET: 'private-bucket',
      R2_ACCESS_KEY_ID: 'key-id',
      R2_SECRET_ACCESS_KEY: 'secret-key',
    })
    expect(store).toBeInstanceOf(R2ObjectStore)
  })

  it('reads binary objects and returns null on 404/NoSuchKey for get and head', async () => {
    const rawBytes = new Uint8Array([0x00, 0x10, 0x80, 0xFF])
    const { client, send } = createMockClient(async (command) => {
      if (command instanceof GetObjectCommand) {
        if (command.input.Key === 'missing.duckdb') {
          const err = Object.assign(new Error('NoSuchKey'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          })
          throw err
        }
        return {
          Body: {
            transformToByteArray: async () => rawBytes,
          },
          ETag: '"etag-1"',
          ContentType: 'application/octet-stream',
        }
      }
      if (command instanceof HeadObjectCommand) {
        if (command.input.Key === 'missing.duckdb') {
          const err = Object.assign(new Error('NotFound'), {
            name: 'NotFound',
            $metadata: { httpStatusCode: 404 },
          })
          throw err
        }
        return {
          ETag: '"etag-1"',
          ContentLength: 4,
          ContentType: 'application/octet-stream',
        }
      }
      throw new Error('Unexpected command')
    })

    const store = new R2ObjectStore({ bucket: 'test-bucket', client })

    expect(await store.get('missing.duckdb')).toBeNull()
    expect(await store.head('missing.duckdb')).toBeNull()

    const got = await store.get('snapshots/a.duckdb')
    expect(got).toEqual({
      body: new Uint8Array([0x00, 0x10, 0x80, 0xFF]),
      etag: '"etag-1"',
      contentType: 'application/octet-stream',
    })

    const head = await store.head('snapshots/a.duckdb')
    expect(head).toEqual({
      etag: '"etag-1"',
      sizeBytes: 4,
      contentType: 'application/octet-stream',
    })
    expect(send).toHaveBeenCalledTimes(4)
  })

  it('sends If-None-Match and If-Match headers on put and maps HTTP 412 to PreconditionFailedError', async () => {
    const sentInputs: Array<PutObjectCommand['input']> = []
    let callCount = 0

    const { client } = createMockClient(async (command) => {
      expect(command).toBeInstanceOf(PutObjectCommand)
      const putCmd = command as PutObjectCommand
      sentInputs.push(putCmd.input)
      callCount += 1

      if (callCount === 1) {
        return { ETag: '"etag-v1"' }
      }
      if (callCount === 2) {
        return { ETag: '"etag-v2"' }
      }
      throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold.'), {
        name: 'PreconditionFailed',
        Code: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
    })

    const store = new R2ObjectStore({ bucket: 'test-bucket', client })

    const r1 = await store.put('manifest.json', new Uint8Array([1, 2]), {
      ifNoneMatch: '*',
      contentType: 'application/json',
    })
    expect(r1.etag).toBe('"etag-v1"')
    expect(sentInputs[0]).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'manifest.json',
      IfNoneMatch: '*',
      ContentType: 'application/json',
    })

    // Unquoted ETag is normalized to quoted form for R2 If-Match.
    const r2 = await store.put('manifest.json', new Uint8Array([3, 4]), {
      ifMatch: 'etag-v1',
    })
    expect(r2.etag).toBe('"etag-v2"')
    expect(sentInputs[1]).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'manifest.json',
      IfMatch: '"etag-v1"',
    })

    await expect(
      store.put('manifest.json', new Uint8Array([5, 6]), { ifMatch: '"stale-etag"' }),
    ).rejects.toThrow(PreconditionFailedError)
  })

  it('paginates ListObjectsV2 across multiple pages', async () => {
    const d1 = new Date('2026-01-01T00:00:00.000Z')
    const d2 = new Date('2026-01-02T00:00:00.000Z')
    const tokens: Array<string | undefined> = []

    const { client } = createMockClient(async (command) => {
      expect(command).toBeInstanceOf(ListObjectsV2Command)
      const listCmd = command as ListObjectsV2Command
      tokens.push(listCmd.input.ContinuationToken)

      if (!listCmd.input.ContinuationToken) {
        return {
          Contents: [
            { Key: 'snapshots/a.duckdb', ETag: '"e1"', Size: 10, LastModified: d1 },
          ],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        }
      }
      return {
        Contents: [
          { Key: 'snapshots/b.duckdb', ETag: '"e2"', Size: 20, LastModified: d2 },
        ],
        IsTruncated: false,
      }
    })

    const store = new R2ObjectStore({ bucket: 'test-bucket', client })
    const items = await store.list('snapshots/')

    expect(tokens).toEqual([undefined, 'page-2'])
    expect(items).toEqual([
      { key: 'snapshots/a.duckdb', etag: '"e1"', sizeBytes: 10, lastModified: d1 },
      { key: 'snapshots/b.duckdb', etag: '"e2"', sizeBytes: 20, lastModified: d2 },
    ])
  })

  it('treats 404 on delete as idempotent success', async () => {
    const { client, send } = createMockClient(async (command) => {
      expect(command).toBeInstanceOf(DeleteObjectCommand)
      throw Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      })
    })

    const store = new R2ObjectStore({ bucket: 'test-bucket', client })
    await expect(store.delete('snapshots/already-gone.duckdb')).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('redacts credentials and presigned query parameters from error messages', async () => {
    const secretAccessKey = 'super-secret-r2-key-9999'
    const accessKeyId = 'AKIA_TEST_R2_KEY'
    const { client } = createMockClient(async () => {
      throw Object.assign(
        new Error(
          `AccessDenied for ${accessKeyId} with ${secretAccessKey} at https://acc.r2.cloudflarestorage.com/b/k?X-Amz-Signature=deadbeef1234&X-Amz-Credential=abc`,
        ),
        {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        },
      )
    })

    const store = new R2ObjectStore({
      bucket: 'test-bucket',
      accessKeyId,
      secretAccessKey,
      client,
    })

    let caught: unknown
    try {
      await store.get('secret.duckdb')
    }
    catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(StorageError)
    const message = (caught as Error).message
    expect(message).not.toContain(secretAccessKey)
    expect(message).not.toContain(accessKeyId)
    expect(message).not.toContain('deadbeef1234')
    expect(message).toContain('X-Amz-Signature=***')
  })
})
