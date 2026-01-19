# Task: エラーハンドリングの改善 (優先度4)

## 目標
エラーの種類に応じて異なるログレベルを使用する

## 設計書参照
docs/ARCHITECTURE.md - 「質問4: エラーハンドリングの改善」セクション（01067-01158行目）

## 変更内容

### src/lib/csrf.ts

#### validateCSRFToken関数の変更
```typescript
export async function validateCSRFToken(
  request: Request
): Promise<{ valid: boolean; error?: string }> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    logger.info('CSRF validation failed: No session found', {  // INFOレベルに変更
      ip: request.headers.get('x-forwarded-for'),
      userAgent: request.headers.get('user-agent'),
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const session = parseSession(sessionCookie)
  const sessionTokenHash = session.csrfTokenHash

  if (!sessionTokenHash) {
    logger.info('CSRF validation failed: No CSRF token in session', {  // INFOレベルに変更
      userId: session.twitchUserId,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const requestToken = cookieStore.get('csrf_token')?.value

  if (!requestToken) {
    logger.info('CSRF validation failed: CSRF token missing in request', {  // INFOレベルに変更
      userId: session.twitchUserId,
      endpoint: request.url,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const requestTokenHash = hashToken(requestToken)

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(sessionTokenHash),
      Buffer.from(requestTokenHash)
    )

    if (!isValid) {
      logger.warn('CSRF token validation failed: Token mismatch (potential attack)', {  // WARNレベル（変更なし）
        userId: session.twitchUserId,
        ip: request.headers.get('x-forwarded-for'),
        referer: request.headers.get('referer'),
        endpoint: request.url,
      })

      reportSecurityError(new Error('CSRF token mismatch'), {
        action: 'csrf_validation',
        userId: session.twitchUserId,
      })

      return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
    }

    return { valid: true }
  } catch (error) {
    // timingSafeEqualはバッファ長不一致でエラーをスロー
    logger.error('CSRF validation failed: Hash comparison error', {  // ERRORレベルに変更
      userId: session.twitchUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }
}
```

## ログレベルの使い分け

### INFOレベル
- セッションが見つからない
- CSRFトークンがセッションにない
- CSRFトークンがリクエストにない
- これらは正常な状況（初回アクセスなど）で発生する可能性がある

### WARNレベル
- CSRFトークン不一致（潜在的な攻撃）
- セキュリティ上の懸念がある場合

### ERRORレベル
- ハッシュ比較エラー（タイミング攻撃の疑いやシステムエラー）
- システムの不具合を示唆する場合

## 理由
- 現在の設計では、すべてのエラーがWARNとして記録されている
- エラーの種類に応じてログレベルを分けることで、より適切な監視が可能になる
- タイミング攻撃の疑いがある場合は、アラートとして検知しやすくなる

## 期待される結果
- エラーの種類に応じて適切な監視が可能
- タイミング攻撃の疑いがある場合、早期に検知できる

## 検証方法
1. 各種エラーシナリオを作成し、適切なログレベルで出力されることを確認
2. ログ監視システムでWARNレベル以上のアラートを設定し、期待通り動作することを確認
