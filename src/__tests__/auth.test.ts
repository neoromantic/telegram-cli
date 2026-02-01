/**
 * Authentication commands tests
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  type AuthDependencies,
  getAuthStatus,
  loginWithPhone,
  loginWithQr,
  logout,
  type QrCodeGenerator,
} from '../commands/auth'
import { type AccountsDbInterface, createTestDatabase } from '../db'

// Set test environment
process.env.BUN_ENV = 'test'

describe('Authentication Commands', () => {
  let accountsDb: AccountsDbInterface
  let mockClients: Map<number, any>
  let deps: AuthDependencies

  beforeEach(() => {
    const testDb = createTestDatabase()
    accountsDb = testDb.accountsDb
    mockClients = new Map()

    // Create mock dependencies
    deps = {
      accountsDb,
      createClient: mock((accountId: number) => {
        const client = {
          id: accountId,
          start: mock(() =>
            Promise.resolve({
              firstName: 'Test',
              lastName: 'User',
              username: 'testuser',
              id: 123,
            }),
          ),
          getMe: mock(() =>
            Promise.resolve({
              firstName: 'Test',
              username: 'testuser',
              id: 123,
            }),
          ),
          signInQr: mock((options: any) => {
            // Simulate QR code flow
            if (options.onUrlUpdated) {
              options.onUrlUpdated('tg://login?token=abc', new Date())
            }
            if (options.onQrScanned) {
              options.onQrScanned()
            }
            return Promise.resolve({
              firstName: 'QR',
              lastName: 'User',
              username: 'qruser',
              id: 456,
            })
          }),
          call: mock(() => Promise.resolve({})),
          close: mock(() => Promise.resolve()),
        }
        mockClients.set(accountId, client)
        return client as any
      }),
      getClient: mock((accountId: number) => {
        let client = mockClients.get(accountId)
        if (!client) {
          client = {
            id: accountId,
            getMe: mock(() =>
              Promise.resolve({
                firstName: 'Test',
                username: 'testuser',
                id: 123,
              }),
            ),
            call: mock(() => Promise.resolve({})),
            close: mock(() => Promise.resolve()),
          }
          mockClients.set(accountId, client)
        }
        return client as any
      }),
      isAuthorized: mock(() => Promise.resolve(true)),
      prompt: mock(() => Promise.resolve('123456')),
      promptPassword: mock(() => Promise.resolve('password123')),
    }
  })

  describe('loginWithPhone', () => {
    it('should create new account and login', async () => {
      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(true)
      expect(result.account).toBeDefined()
      expect(result.account?.phone).toBe('+1234567890')
      expect(result.account?.name).toBe('Test')
      expect(result.account?.username).toBe('testuser')
    })

    it('should use existing account if phone exists', async () => {
      const existing = accountsDb.create({
        phone: '+1234567890',
        name: 'Existing',
      })

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(true)
      expect(result.account?.id).toBe(existing.id)
    })

    it('should set existing account as active when relogging', async () => {
      accountsDb.create({ phone: '+1111111111', is_active: true })
      accountsDb.create({ phone: '+2222222222', is_active: false })

      // Re-login to existing account should set it as active
      await loginWithPhone('+2222222222', deps)

      const active = accountsDb.getActive()
      expect(active?.phone).toBe('+2222222222')
    })

    it('should update account name after login', async () => {
      await loginWithPhone('+1234567890', deps)

      const account = accountsDb.getByPhone('+1234567890')
      expect(account?.name).toBe('Test User')
    })

    it('should return error on login failure', async () => {
      deps.createClient = mock(() => ({
        start: mock(() => Promise.reject(new Error('Invalid phone'))),
        close: mock(() => Promise.resolve()),
      })) as any

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid phone')
    })

    it('should handle non-Error exceptions', async () => {
      deps.createClient = mock(() => ({
        start: mock(() => Promise.reject('string error')),
        close: mock(() => Promise.resolve()),
      })) as any

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Unknown error')
    })

    it('should handle user without lastName', async () => {
      deps.createClient = mock((_accountId: number) => ({
        start: mock(() =>
          Promise.resolve({
            firstName: 'Single',
            lastName: null,
            username: 'single',
            id: 123,
          }),
        ),
        close: mock(() => Promise.resolve()),
      })) as any

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(true)
      const account = accountsDb.getByPhone('+1234567890')
      expect(account?.name).toBe('Single')
    })
  })

  describe('loginWithQr', () => {
    let mockQrGenerator: QrCodeGenerator

    beforeEach(() => {
      mockQrGenerator = {
        generate: mock((_url, _options, callback) => {
          callback('QR_CODE_HERE')
        }),
      }
      deps.qrGenerator = mockQrGenerator
    })

    it('should create new account and login via QR', async () => {
      const result = await loginWithQr('test_account', deps)

      expect(result.success).toBe(true)
      expect(result.account).toBeDefined()
      expect(result.account?.name).toBe('QR')
      expect(result.account?.username).toBe('qruser')
      expect(result.account?.userId).toBe(456)
    })

    it('should generate default account name if not provided', async () => {
      const result = await loginWithQr(undefined, deps)

      expect(result.success).toBe(true)
      // After successful login, account phone is updated to user:userId
      const accounts = accountsDb.getAll()
      expect(accounts[0]?.phone).toBe('user:456')
    })

    it('should update phone with user ID after login', async () => {
      await loginWithQr('test', deps)

      const account = accountsDb.getByPhone('user:456')
      expect(account).toBeDefined()
    })

    it('should delete account on failure', async () => {
      deps.createClient = mock(() => ({
        signInQr: mock(() => Promise.reject(new Error('QR expired'))),
        close: mock(() => Promise.resolve()),
      })) as any

      const result = await loginWithQr('test', deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('QR expired')
      expect(accountsDb.count()).toBe(0)
    })

    it('should call QR generator', async () => {
      await loginWithQr('test', deps)

      expect(mockQrGenerator.generate).toHaveBeenCalled()
    })
  })

  describe('logout', () => {
    it('should logout and delete account', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })

      const result = await logout(account.id, deps)

      expect(result.success).toBe(true)
      expect(result.accountId).toBe(account.id)
      expect(result.phone).toBe('+1234567890')
      expect(accountsDb.getById(account.id)).toBeNull()
    })

    it('should logout active account if no ID specified', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })

      const result = await logout(undefined, deps)

      expect(result.success).toBe(true)
      expect(result.accountId).toBe(account.id)
    })

    it('should return error if no account found', async () => {
      const result = await logout(undefined, deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('No account found to logout')
    })

    it('should return error if specified account not found', async () => {
      const result = await logout(999, deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('No account found to logout')
    })

    it('should call auth.logOut on client', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      const client = deps.getClient(account.id)

      await logout(account.id, deps)

      expect(client.call).toHaveBeenCalledWith({ _: 'auth.logOut' })
    })

    it('should return error on API failure', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.getClient = mock(() => ({
        call: mock(() => Promise.reject(new Error('Network error'))),
        close: mock(() => Promise.resolve()),
      })) as any

      const result = await logout(account.id, deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })

  describe('getAuthStatus', () => {
    it('should return authenticated status', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.resolve(true))

      const result = await getAuthStatus(account.id, deps)

      expect(result.authenticated).toBe(true)
      expect(result.account).toBeDefined()
      expect(result.account?.phone).toBe('+1234567890')
      expect(result.account?.username).toBe('testuser')
      expect(result.account?.userId).toBe(123)
    })

    it('should return not authenticated if no account', async () => {
      const result = await getAuthStatus(undefined, deps)

      expect(result.authenticated).toBe(false)
      expect(result.message).toBe('No account configured')
    })

    it('should use active account if no ID specified', async () => {
      accountsDb.create({ phone: '+1234567890', is_active: true })

      const result = await getAuthStatus(undefined, deps)

      expect(result.account?.phone).toBe('+1234567890')
    })

    it('should return not authenticated if client not authorized', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.resolve(false))

      const result = await getAuthStatus(account.id, deps)

      expect(result.authenticated).toBe(false)
      expect(result.message).toContain('not authenticated')
    })

    it('should return not authenticated on error', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.reject(new Error('Network error')))

      const result = await getAuthStatus(account.id, deps)

      expect(result.authenticated).toBe(false)
      expect(result.message).toBe('Could not verify authentication status')
    })

    it('should return account info even when not authorized', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.resolve(false))

      const result = await getAuthStatus(account.id, deps)

      expect(result.account).toBeDefined()
      expect(result.account?.id).toBe(account.id)
      expect(result.account?.phone).toBe('+1234567890')
    })
  })
})
