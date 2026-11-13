import { safeStorage } from 'electron'

const ENC_PREFIX = 'enc:'
const B64_PREFIX = 'b64:'

/** 使用操作系统级加密（Windows DPAPI / macOS Keychain / Linux libsecret）保存敏感串 */
export function encryptSecret(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  }
  return B64_PREFIX + Buffer.from(plain, 'utf8').toString('base64')
}

export function decryptSecret(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return ''
    }
  }
  if (stored.startsWith(B64_PREFIX)) {
    return Buffer.from(stored.slice(B64_PREFIX.length), 'base64').toString('utf8')
  }
  return ''
}
