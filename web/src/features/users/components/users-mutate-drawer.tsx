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
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Eye, EyeOff, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import {
  SideDrawerSection,
  sideDrawerContentClassName,
  sideDrawerFooterClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { PermissionMatrix } from '@/components/permission-matrix'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  ADMIN_PERMISSION_ACTIONS,
  ADMIN_PERMISSION_RESOURCES,
  EMPTY_PERMISSION_CATALOG,
  hasPermission,
  normalizeAdminPermissions,
  type AdminPermissionMatrix,
} from '@/lib/admin-permissions'
import { getCurrencyDisplay, getCurrencyLabel } from '@/lib/currency'
import {
  formatQuota,
  formatTimestampToDate,
  parseQuotaFromDollars,
} from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { accountPasswordSchema } from '@/lib/password-policy'
import { ROLE } from '@/lib/roles'
import { AuthOperationError } from '@/lib/secure-verification'
import {
  createServerError,
  getServerErrorMessage,
  requireServerSuccess,
} from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  createUser,
  getUser,
  getUserUpstreamKey,
  getGroups,
  getPermissionCatalog,
  revealUserUpstreamKey,
  updateUser,
} from '../api'
import { BINDING_FIELDS, ERROR_MESSAGES, SUCCESS_MESSAGES } from '../constants'
import {
  userFormSchema,
  type UserFormValues,
  USER_FORM_DEFAULT_VALUES,
  transformFormDataToPayload,
  transformUserToFormDefaults,
} from '../lib'
import type { User } from '../types'
import { UserQuotaDialog } from './user-quota-dialog'
import { useUsers } from './users-provider'

type UsersMutateDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow?: User
}

export function UsersMutateDrawer({
  open,
  onOpenChange,
  currentRow,
}: UsersMutateDrawerProps) {
  const { t } = useTranslation()
  const isUpdate = !!currentRow
  const { triggerRefresh, requestVerification } = useUsers()
  const currentUser = useAuthStore((s) => s.auth.user)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false)
  // Matrix as loaded from the server; an unchanged matrix is not resubmitted so
  // routine edits of an administrator do not require step-up verification.
  const loadedPermissions = useRef<AdminPermissionMatrix | undefined>(undefined)

  // Fetch groups
  const { data: groupsData } = useQuery({
    queryKey: ['groups'],
    queryFn: async () => requireServerSuccess(await getGroups()),
    staleTime: 5 * 60 * 1000,
  })

  const groups = groupsData?.data || []

  // Permission catalog is owned by the backend; fetched once and reused.
  const { data: permissionCatalog = EMPTY_PERMISSION_CATALOG } = useQuery({
    queryKey: ['admin-permission-catalog'],
    queryFn: async () => requireServerSuccess(await getPermissionCatalog()),
    staleTime: 5 * 60 * 1000,
  })

  const form = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: USER_FORM_DEFAULT_VALUES,
  })

  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [isRevealingKey, setIsRevealingKey] = useState(false)
  const targetUserId = currentRow?.id ?? 0

  const upstreamKeyQuery = useQuery({
    queryKey: ['user-upstream-key', targetUserId],
    queryFn: async () =>
      requireServerSuccess(await getUserUpstreamKey(targetUserId)),
    enabled: open && isUpdate && targetUserId > 0,
    meta: { errorToast: false },
  })

  useEffect(() => {
    if (!open) {
      setRevealedKey(null)
    }
  }, [open, currentRow?.id])

  // Load existing data when updating
  useEffect(() => {
    if (open && isUpdate && currentRow) {
      // For update, fetch fresh data
      getUser(currentRow.id)
        .then((result) => {
          if (result.success && result.data) {
            loadedPermissions.current = result.data.admin_permissions
            form.reset(transformUserToFormDefaults(result.data))
          } else {
            handleServerError(result, t('Failed to load'))
          }
        })
        .catch((error) => handleServerError(error, t('Failed to load')))
    } else if (open && !isUpdate) {
      // For create, reset to defaults
      form.reset(USER_FORM_DEFAULT_VALUES)
    }
  }, [open, isUpdate, currentRow, form, t])

  const { meta: currencyMeta } = getCurrencyDisplay()
  const currencyLabel = getCurrencyLabel()
  const tokensOnly = currencyMeta.kind === 'tokens'

  const currentQuotaRaw = form.watch('quota_dollars') || 0
  const selectedRole = form.watch('role')
  const canEditAdminPermissions = currentUser?.role === ROLE.SUPER_ADMIN
  const targetIsAdmin = (selectedRole ?? currentRow?.role ?? 0) >= ROLE.ADMIN

  const onSubmit = async (data: UserFormValues) => {
    if (!isUpdate || data.password) {
      if (!accountPasswordSchema.safeParse(data.password ?? '').success) {
        form.setError('password', {
          type: 'manual',
          message: t('Password must contain between 8 and 128 characters.'),
        })
        return
      }
    }

    setIsSubmitting(true)
    try {
      const payload = transformFormDataToPayload(
        data,
        currentRow?.id,
        permissionCatalog
      )
      if (
        isUpdate &&
        payload.admin_permissions &&
        JSON.stringify(payload.admin_permissions) ===
          JSON.stringify(
            normalizeAdminPermissions(
              loadedPermissions.current,
              permissionCatalog
            )
          )
      ) {
        delete payload.admin_permissions
      }
      // Resetting a password, rewriting admin permissions, changing the
      // upstream key, or creating an administrator changes who can sign in,
      // what they may do, or which upstream credential they use.
      const keyChanged = Boolean(
        payload.upstream_key || payload.remove_upstream_key
      )
      let proofToken: string | undefined
      if (isUpdate && currentRow) {
        if (payload.password || payload.admin_permissions || keyChanged) {
          const proof = await requestVerification({
            scope: 'admin.user.update',
            context: { user_id: currentRow.id },
            title: t('Verify to update user credentials'),
            description: t(
              'Confirm your identity before changing the account {{username}}.',
              { username: currentRow.username }
            ),
          })
          if (!proof) return
          proofToken = proof.proof_token
        }
      } else if ((payload.role ?? 0) >= ROLE.ADMIN || keyChanged) {
        const proof = await requestVerification({
          scope: 'admin.user.create',
          context: { role: payload.role ?? ROLE.ADMIN },
          title:
            (payload.role ?? 0) >= ROLE.ADMIN
              ? t('Verify to create administrator')
              : t('Verify to create user with upstream key'),
          description:
            (payload.role ?? 0) >= ROLE.ADMIN
              ? t('Confirm your identity before creating an administrator account.')
              : t(
                  'Confirm your identity before creating this account with an upstream key.'
                ),
        })
        if (!proof) return
        proofToken = proof.proof_token
      }
      const result = isUpdate
        ? await updateUser(
            payload as typeof payload & { id: number },
            proofToken
          )
        : await createUser(payload, proofToken)

      if (result.success) {
        toast.success(
          isUpdate
            ? t(SUCCESS_MESSAGES.USER_UPDATED)
            : t(SUCCESS_MESSAGES.USER_CREATED)
        )
        onOpenChange(false)
        triggerRefresh()
      } else {
        handleServerError(result, t(ERROR_MESSAGES.CREATE_FAILED))
      }
    } catch (error) {
      handleServerError(
        AuthOperationError.from(error),
        t(ERROR_MESSAGES.UNEXPECTED)
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const refreshUserData = async () => {
    if (!currentRow) return
    try {
      const result = requireServerSuccess(await getUser(currentRow.id))
      if (result.success && result.data) {
        loadedPermissions.current = result.data.admin_permissions
        form.reset(transformUserToFormDefaults(result.data))
      }
      triggerRefresh()
    } catch (error) {
      handleServerError(error, t('Failed to load'))
    }
  }

  const upstreamStatus = upstreamKeyQuery.data?.data
  const upstreamConfigured = upstreamStatus?.configured === true

  const handleRevealUpstreamKey = async () => {
    if (!currentRow || isRevealingKey) return
    setIsRevealingKey(true)
    try {
      const proof = await requestVerification({
        scope: 'admin.user.upstream_key.read',
        context: { user_id: currentRow.id },
        title: t('Verify to view upstream key'),
        description: t(
          'Confirm your identity before revealing the key for {{username}}.',
          { username: currentRow.username }
        ),
      })
      if (!proof) return
      const result = await revealUserUpstreamKey(
        currentRow.id,
        proof.proof_token
      )
      if (!result.success) {
        throw createServerError(result, t('Failed to fetch upstream key'))
      }
      setRevealedKey(result.data?.key ?? '')
    } catch (error) {
      handleServerError(AuthOperationError.from(error))
    } finally {
      setIsRevealingKey(false)
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          onOpenChange(v)
          if (!v) {
            form.reset()
          }
        }}
      >
        <SheetContent
          className={sideDrawerContentClassName('sm:max-w-[600px]')}
        >
          <SheetHeader className={sideDrawerHeaderClassName()}>
            <SheetTitle>
              {isUpdate ? t('Update') : t('Create')} {t('User')}
            </SheetTitle>
            <SheetDescription>
              {isUpdate
                ? t('Update the user by providing necessary info.')
                : t('Add a new user by providing necessary info.')}
            </SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <form
              id='user-form'
              onSubmit={form.handleSubmit(onSubmit)}
              className={sideDrawerFormClassName()}
            >
              {/* Basic Information */}
              <SideDrawerSection>
                <h3 className='text-sm font-medium'>
                  {t('Basic Information')}
                </h3>

                <FormField
                  control={form.control}
                  name='username'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Username')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder={t('Enter username')}
                          disabled={isUpdate}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {!isUpdate && (
                  <FormField
                    control={form.control}
                    name='role'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Role')}</FormLabel>
                        <Select
                          items={[
                            { value: '1', label: t('Common User') },
                            { value: '10', label: t('Admin') },
                          ]}
                          onValueChange={(value) =>
                            value !== null &&
                            field.onChange(Number.parseInt(value))
                          }
                          value={String(field.value)}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('Select a role')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent alignItemWithTrigger={false}>
                            <SelectGroup>
                              <SelectItem value='1'>
                                {t('Common User')}
                              </SelectItem>
                              <SelectItem value='10'>{t('Admin')}</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <FormDescription>
                          {t("Set the user's role (cannot be Root)")}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name='display_name'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Display Name')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder={t('Enter display name')}
                        />
                      </FormControl>
                      <FormDescription>
                        {t('Leave empty to use username')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name='password'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Password')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type='password'
                          placeholder={
                            isUpdate
                              ? t('Leave empty to keep unchanged')
                              : t('Enter password (8–128 characters)')
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </SideDrawerSection>

              {/* Upstream Key */}
              <SideDrawerSection>
                <h3 className='text-sm font-medium'>{t('Upstream Key')}</h3>

                {isUpdate ? (
                  <div className='border-border/60 flex flex-col gap-2 rounded-lg border p-3'>
                    {upstreamKeyQuery.isLoading ? (
                      <p className='text-muted-foreground text-sm'>
                        {t('Loading...')}
                      </p>
                    ) : null}
                    {upstreamKeyQuery.isError ? (
                      <p className='text-destructive text-sm'>
                        {getServerErrorMessage(
                          upstreamKeyQuery.error,
                          t('Failed to load upstream key')
                        )}
                      </p>
                    ) : null}
                    {!upstreamKeyQuery.isLoading &&
                    !upstreamKeyQuery.isError ? (
                      <>
                        <div className='flex flex-wrap items-start justify-between gap-2'>
                          <div className='min-w-0 space-y-1'>
                            <p className='text-sm font-medium'>
                              {upstreamConfigured
                                ? t('Configured')
                                : t('Not configured')}
                            </p>
                            {upstreamConfigured ? (
                              <code className='text-muted-foreground text-xs break-all'>
                                {upstreamStatus?.key_preview}
                              </code>
                            ) : null}
                            {upstreamConfigured && upstreamStatus?.updated_time ? (
                              <p className='text-muted-foreground text-xs'>
                                {t('Last updated')}:{' '}
                                {formatTimestampToDate(upstreamStatus.updated_time)}
                              </p>
                            ) : null}
                          </div>
                          {upstreamConfigured ? (
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon-sm'
                              aria-label={
                                revealedKey === null
                                  ? t('Reveal key')
                                  : t('Hide key')
                              }
                              disabled={isRevealingKey}
                              onClick={() => {
                                if (revealedKey !== null) {
                                  setRevealedKey(null)
                                  return
                                }
                                void handleRevealUpstreamKey()
                              }}
                            >
                              {revealedKey === null ? (
                                <Eye className='size-4' />
                              ) : (
                                <EyeOff className='size-4' />
                              )}
                            </Button>
                          ) : null}
                        </div>
                        {revealedKey !== null ? (
                          <div className='bg-muted/40 flex flex-col gap-2 rounded-md p-2'>
                            <code className='text-xs break-all'>
                              {revealedKey}
                            </code>
                            <div className='flex items-center gap-1'>
                              <CopyButton value={revealedKey} />
                              <Button
                                type='button'
                                variant='ghost'
                                size='sm'
                                onClick={() => setRevealedKey(null)}
                              >
                                <EyeOff className='mr-1 size-4' />
                                {t('Hide key')}
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}

                <FormField
                  control={form.control}
                  name='upstream_key'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Upstream Key')}</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          rows={3}
                          maxLength={8192}
                          autoComplete='off'
                          spellCheck={false}
                          placeholder={t('Paste your upstream API key')}
                          onChange={(event) => {
                            field.onChange(event)
                            if (event.target.value.trim()) {
                              form.setValue('remove_upstream_key', false)
                            }
                          }}
                        />
                      </FormControl>
                      <FormDescription>
                        {isUpdate
                          ? t('Leave blank to keep the current upstream key.')
                          : t(
                              'Optional. The key is used by every channel that enables per-user keys.'
                            )}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {isUpdate && upstreamConfigured ? (
                  <FormField
                    control={form.control}
                    name='remove_upstream_key'
                    render={({ field }) => (
                      <FormItem className='border-border/60 flex flex-row items-start justify-between gap-3 rounded-lg border p-3'>
                        <div className='space-y-1'>
                          <FormLabel>
                            {t('Remove the current upstream key')}
                          </FormLabel>
                          <FormDescription>
                            {t(
                              'The account will no longer be able to use channels that require per-user keys.'
                            )}
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value === true}
                            aria-label={t('Remove the current upstream key')}
                            onCheckedChange={(checked) => {
                              field.onChange(checked)
                              if (checked) {
                                form.setValue('upstream_key', '')
                              }
                            }}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                ) : null}
              </SideDrawerSection>

              {/* Group & Quota Settings (Update only) */}
              {isUpdate && (
                <SideDrawerSection>
                  <h3 className='text-sm font-medium'>{t('Group & Quota')}</h3>

                  <FormField
                    control={form.control}
                    name='group'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Group')}</FormLabel>
                        <FormControl>
                          <Combobox
                            options={groups.map((group) => ({
                              value: group,
                              label: group,
                            }))}
                            onValueChange={field.onChange}
                            value={field.value}
                            className='w-full'
                            placeholder={t('Select a group')}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name='quota_dollars'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t('Remaining Quota ({{currency}})', {
                            currency: currencyLabel,
                          })}
                        </FormLabel>
                        <div className='flex gap-2'>
                          <FormControl>
                            <Input
                              value={
                                tokensOnly
                                  ? String(field.value || 0)
                                  : (field.value || 0).toFixed(6)
                              }
                              readOnly
                              className='flex-1'
                            />
                          </FormControl>
                          <Button
                            type='button'
                            variant='outline'
                            onClick={() => setQuotaDialogOpen(true)}
                          >
                            <Pencil className='mr-1 h-4 w-4' />
                            {t('Adjust Quota')}
                          </Button>
                        </div>
                        <FormDescription>
                          {formatQuota(parseQuotaFromDollars(field.value || 0))}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name='remark'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Remark')}</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            placeholder={t(
                              'Admin notes (only visible to admins)'
                            )}
                            rows={3}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </SideDrawerSection>
              )}

              {canEditAdminPermissions &&
                targetIsAdmin &&
                permissionCatalog.resources.length > 0 && (
                  <SideDrawerSection>
                    <h3 className='text-sm font-medium'>
                      {t('Admin Permissions')}
                    </h3>
                    <p className='text-muted-foreground text-xs'>
                      {t(
                        'Default administrator permissions can be overridden for this user.'
                      )}
                    </p>
                    <FormField
                      control={form.control}
                      name='admin_permissions'
                      render={({ field }) => {
                        const selected = normalizeAdminPermissions(
                          field.value,
                          permissionCatalog
                        )
                        return (
                          <FormItem>
                            <PermissionMatrix
                              resources={permissionCatalog.resources}
                              value={selected}
                              onChange={field.onChange}
                            />
                            <FormMessage />
                          </FormItem>
                        )
                      }}
                    />
                    {currentUser && (
                      <p className='text-muted-foreground text-xs'>
                        {hasPermission(
                          currentUser,
                          ADMIN_PERMISSION_RESOURCES.CHANNEL,
                          ADMIN_PERMISSION_ACTIONS.SENSITIVE_WRITE
                        )
                          ? t(
                              'Your account can edit sensitive channel settings.'
                            )
                          : t(
                              'Your account cannot edit sensitive channel settings.'
                            )}
                      </p>
                    )}
                  </SideDrawerSection>
                )}

              {/* Binding Information (Read-only) */}
              {isUpdate && (
                <SideDrawerSection>
                  <h3 className='text-sm font-medium'>
                    {t('Binding Information')}
                  </h3>
                  <p className='text-muted-foreground text-xs'>
                    {t(
                      'Third-party account bindings (read-only, managed by user in Security & Access)'
                    )}
                  </p>

                  <div className='flex flex-col gap-3'>
                    {BINDING_FIELDS.map(({ key, label }) => (
                      <div key={key}>
                        <Label className='text-muted-foreground text-xs'>
                          {t(label)}
                        </Label>
                        <Input
                          value={
                            (currentRow?.[key as keyof User] as string) || '-'
                          }
                          disabled
                          className='mt-1'
                        />
                      </div>
                    ))}
                  </div>
                </SideDrawerSection>
              )}
            </form>
          </Form>
          <SheetFooter className={sideDrawerFooterClassName()}>
            <SheetClose render={<Button variant='outline' />}>
              {t('Close')}
            </SheetClose>
            <Button form='user-form' type='submit' disabled={isSubmitting}>
              {isSubmitting ? t('Saving...') : t('Save changes')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Adjust Quota Dialog */}
      {currentRow && (
        <UserQuotaDialog
          open={quotaDialogOpen}
          onOpenChange={setQuotaDialogOpen}
          userId={currentRow.id}
          currentQuota={parseQuotaFromDollars(currentQuotaRaw || 0)}
          onSuccess={refreshUserData}
        />
      )}
    </>
  )
}
