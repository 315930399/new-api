/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { User, UserUpstreamKeyStatus } from '../../types'
import { UsersMutateDrawer } from '../users-mutate-drawer'
import { UsersProvider } from '../users-provider'

const target: User = {
  id: 2,
  username: 'managed-user',
  display_name: 'Managed user',
  role: 1,
  status: 1,
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'default',
}

let upstreamStatus: UserUpstreamKeyStatus

function renderDrawer() {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'operator', role: 100 })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <UsersProvider>
        <UsersMutateDrawer
          open
          onOpenChange={() => undefined}
          currentRow={target}
        />
      </UsersProvider>
    </QueryClientProvider>
  )
}

async function verifyTwoFactor(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText('Authenticator code or backup code'),
    '123456'
  )
  await user.click(screen.getByRole('button', { name: 'Verify' }))
}

beforeEach(() => {
  upstreamStatus = {
    configured: false,
    key_preview: '',
    updated_time: 0,
  }
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/user/2') {
      return {
        data: {
          success: true,
          data: { ...target, admin_permissions: {} },
        },
      }
    }
    if (url === '/api/user/2/upstream_key') {
      return { data: { success: true, data: upstreamStatus } }
    }
    if (url === '/api/authz/catalog') {
      return {
        data: {
          success: true,
          data: { resources: [], roles: [] },
        },
      }
    }
    if (url === '/api/group/') {
      return { data: { success: true, data: ['default'] } }
    }
    if (url === '/api/verify/methods') {
      return {
        data: {
          success: true,
          data: {
            scope: 'admin.user.update',
            methods: [{ method: '2fa', available: true }],
            oauth_providers: [],
            password_encryption_enabled: false,
          },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  vi.spyOn(api, 'put').mockResolvedValue({
    data: { success: true, message: '', data: target },
  })
  vi.spyOn(api, 'post').mockImplementation(async (url, data) => {
    if (url === '/api/verify') {
      return {
        data: {
          success: true,
          data: {
            proof_token: 'user-key-proof',
            method: '2fa',
            scope: (data as { scope: string }).scope,
            expires_at: Math.floor(Date.now() / 1000) + 60,
          },
        },
      }
    }
    if (url === '/api/user/2/upstream_key/key') {
      return { data: { success: true, data: { key: 'sk-full-key' } } }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

describe('UsersMutateDrawer upstream key', () => {
  it('saves a new upstream key with the user update', async () => {
    const user = userEvent.setup()
    renderDrawer()

    await screen.findByDisplayValue('Managed user')
    await user.type(
      screen.getByPlaceholderText('Paste your upstream API key'),
      'sk-new-key'
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await verifyTwoFactor(user)

    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(
        '/api/user/',
        expect.objectContaining({
          id: 2,
          upstream_key: 'sk-new-key',
        }),
        expect.objectContaining({
          headers: { 'X-Security-Proof': 'user-key-proof' },
          singleUseAuthorization: true,
        })
      )
    )
  })

  it('removes an existing upstream key with the user update', async () => {
    const user = userEvent.setup()
    upstreamStatus = {
      configured: true,
      key_preview: 'sk-f...-key',
      updated_time: Math.floor(Date.now() / 1000),
    }
    renderDrawer()

    await screen.findByText('sk-f...-key')
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await verifyTwoFactor(user)

    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(
        '/api/user/',
        expect.objectContaining({
          id: 2,
          remove_upstream_key: true,
        }),
        expect.objectContaining({
          headers: { 'X-Security-Proof': 'user-key-proof' },
        })
      )
    )
    const payload = vi.mocked(api.put).mock.calls[0][1] as Record<
      string,
      unknown
    >
    expect(payload.upstream_key).toBeUndefined()
  })

  it('reveals the existing key after step-up', async () => {
    const user = userEvent.setup()
    upstreamStatus = {
      configured: true,
      key_preview: 'sk-f...-key',
      updated_time: Math.floor(Date.now() / 1000),
    }
    renderDrawer()

    await screen.findByText('sk-f...-key')
    await user.click(screen.getByRole('button', { name: 'Reveal key' }))
    await verifyTwoFactor(user)

    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/api/user/2/upstream_key/key',
        undefined,
        expect.objectContaining({
          headers: { 'X-Security-Proof': 'user-key-proof' },
        })
      )
    )
    expect(await screen.findByText('sk-full-key')).toBeInTheDocument()
  })
})
