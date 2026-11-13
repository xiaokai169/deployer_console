import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import type { EncryptedPayload } from '@shared/types'

const ALG = 'aes-256-gcm'
const KDF = 'scrypt'

/** 用口令加密 JSON（scrypt 派生密钥 + AES-256-GCM） */
export function encryptJson(value: unknown, passphrase: string): EncryptedPayload {
  const salt = randomBytes(16)
  const key = scryptSync(passphrase, salt, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALG, key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return {
    alg: ALG,
    kdf: KDF,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

/** 解密；口令错误会因认证标签校验失败而抛错 */
export function decryptJson<T>(payload: EncryptedPayload, passphrase: string): T {
  if (!payload || payload.alg !== ALG || payload.kdf !== KDF) {
    throw new Error('不支持的加密格式')
  }
  const salt = Buffer.from(payload.salt, 'base64')
  const key = scryptSync(passphrase, salt, 32)
  const decipher = createDecipheriv(ALG, key, Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ])
  return JSON.parse(decrypted.toString('utf8')) as T
}
