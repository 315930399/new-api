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
import { describe, expect, test } from 'vitest'

import { CHANNEL_FORM_DEFAULT_VALUES, buildSettingJSON } from '../channel-form'

describe('channel form per-user key setting', () => {
  test('persists the enabled per-user key mode in the channel setting JSON', () => {
    const setting = JSON.parse(
      buildSettingJSON({
        ...CHANNEL_FORM_DEFAULT_VALUES,
        type: 1,
        user_key_mode: true,
      })
    )

    expect(setting.user_key_mode).toBe(true)
  })

  test('writes the per-user key mode as disabled when the form leaves it off', () => {
    const setting = JSON.parse(
      buildSettingJSON({ ...CHANNEL_FORM_DEFAULT_VALUES, type: 1 })
    )

    expect(setting.user_key_mode).toBe(false)
  })
})
