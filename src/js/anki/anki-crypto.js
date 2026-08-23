/**
 * Anki API Key 对称加密原语（Web Crypto API）：
 *  - 加密：随机 salt + 96-bit IV → PBKDF2-SHA-256(passphrase) 派生 AES-256-GCM 密钥 → 加密明文。
 *  - 密文载荷为 JSON 字符串，携带版本 / KDF / 迭代次数 / salt / iv / ct 元数据，可安全上传 Gist 或写入备份。
 *  - 解密：校验载荷字段后重放 PBKDF2；passphrase 错误或密文被篡改时 AES-GCM 认证失败并抛错。
 *  - 口令永不落盘到密文载荷，也永不进入 Gist。
 */

export const ANKI_CRYPTO_VERSION = 1
export const ANKI_KDF_NAME = 'pbkdf2-sha256'
export const ANKI_PBKDF2_ITERATIONS = 210000
export const ANKI_SALT_BYTES = 16
export const ANKI_IV_BYTES = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function base64ToBytes(str) {
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function ensureCryptoAvailable() {
  if (
    typeof crypto === 'undefined' ||
    !crypto.subtle ||
    typeof crypto.subtle.importKey !== 'function' ||
    typeof crypto.getRandomValues !== 'function'
  ) {
    const err = new Error('crypto-unavailable')
    err.code = 'crypto-unavailable'
    throw err
  }
}

async function deriveKey(passphrase, saltBytes) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: ANKI_PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptAnkiSecret(plaintext, passphrase) {
  ensureCryptoAvailable()
  const salt = crypto.getRandomValues(new Uint8Array(ANKI_SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(ANKI_IV_BYTES))
  const key = await deriveKey(passphrase, salt)
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  )
  return JSON.stringify({
    v: ANKI_CRYPTO_VERSION,
    kdf: ANKI_KDF_NAME,
    iter: ANKI_PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(cipherBuffer))
  })
}

export async function decryptAnkiSecret(payloadStr, passphrase) {
  ensureCryptoAvailable()
  const parsed = parseAnkiEncryptedPayload(payloadStr)
  const salt = base64ToBytes(parsed.salt)
  const iv = base64ToBytes(parsed.iv)
  const key = await deriveKey(passphrase, salt)
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    base64ToBytes(parsed.ct)
  )
  return decoder.decode(plainBuffer)
}

export function parseAnkiEncryptedPayload(payloadStr) {
  let parsed
  try {
    parsed = JSON.parse(payloadStr)
  } catch {
    throw new Error('invalid-encrypted-payload')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.v !== ANKI_CRYPTO_VERSION ||
    parsed.kdf !== ANKI_KDF_NAME ||
    typeof parsed.iter !== 'number' ||
    parsed.iter < 1 ||
    typeof parsed.salt !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ct !== 'string'
  ) {
    throw new Error('unsupported-encrypted-payload')
  }
  return parsed
}
