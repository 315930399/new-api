package model

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func userUpstreamKeyFilters(userId int) []dto.ChannelFilter {
	return []dto.ChannelFilter{{Kind: dto.FilterUserUpstreamKey, UserId: userId}}
}

// setupUserUpstreamKeyTest prepares channels whose credentials are swapped for
// the user's single upstream key and leaves the memory cache warm.
func setupUserUpstreamKeyTest(t *testing.T) {
	t.Helper()
	truncateTables(t)
	originalMemoryCache := common.MemoryCacheEnabled
	common.MemoryCacheEnabled = true
	t.Cleanup(func() {
		common.MemoryCacheEnabled = originalMemoryCache
		InitChannelCache()
	})
}

func createUserUpstreamKeyTestUser(t *testing.T, id int, username string) {
	t.Helper()
	user := User{
		Id:          id,
		Username:    username,
		Password:    "unused-password-hash",
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
		AffCode:     username,
	}
	require.NoError(t, DB.Create(&user).Error)
}

func TestUserUpstreamKeyModeHidesUnkeyedUsers(t *testing.T) {
	setupUserUpstreamKeyTest(t)

	userKeyMode := `{"user_key_mode":true}`
	channels := []Channel{
		{Id: 930001, Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Name: "keyed", Models: "keyed-model", Group: "default", Setting: &userKeyMode},
		{Id: 930002, Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Name: "unkeyed", Models: "unkeyed-model", Group: "default", Setting: &userKeyMode},
		{Id: 930003, Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Name: "shared", Models: "shared-model", Group: "default"},
	}
	for i := range channels {
		require.NoError(t, channels[i].Insert())
	}
	createUserUpstreamKeyTestUser(t, 7, "user-key-seven")
	require.NoError(t, errorOnlyUpsert(7, "sk-user-7"))
	InitChannelCache()

	selected, err := GetRandomSatisfiedChannel("default", "keyed-model", 0, userUpstreamKeyFilters(7))
	require.NoError(t, err)
	require.NotNil(t, selected)
	assert.Equal(t, "keyed", selected.Name)

	selected, err = GetRandomSatisfiedChannel("default", "unkeyed-model", 0, userUpstreamKeyFilters(7))
	require.NoError(t, err)
	require.NotNil(t, selected)
	assert.Equal(t, "unkeyed", selected.Name, "the same user key serves every channel in the mode")

	_, err = GetRandomSatisfiedChannel("default", "keyed-model", 0, userUpstreamKeyFilters(8))
	require.ErrorIs(t, err, ErrUserUpstreamKeyRequired)

	_, err = GetRandomSatisfiedChannel("default", "unkeyed-model", 0, userUpstreamKeyFilters(8))
	require.ErrorIs(t, err, ErrUserUpstreamKeyRequired)

	selected, err = GetRandomSatisfiedChannel("default", "shared-model", 0, userUpstreamKeyFilters(7))
	require.NoError(t, err)
	require.NotNil(t, selected)
	assert.Equal(t, "shared", selected.Name, "channels without per-user key mode ignore the filter")

	// The database path applies the same rule when memory cache is disabled.
	common.MemoryCacheEnabled = false
	selected, err = GetChannel("default", "keyed-model", 0, userUpstreamKeyFilters(7))
	require.NoError(t, err)
	require.NotNil(t, selected)
	assert.Equal(t, "keyed", selected.Name)

	_, err = GetChannel("default", "unkeyed-model", 0, userUpstreamKeyFilters(8))
	require.ErrorIs(t, err, ErrUserUpstreamKeyRequired)
}

func TestUserUpstreamKeyResolutionFollowsChannelMode(t *testing.T) {
	setupUserUpstreamKeyTest(t)

	createUserUpstreamKeyTestUser(t, 7, "user-key-resolution")
	userKeyMode := `{"user_key_mode":true}`
	first := Channel{Id: 931001, Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Name: "first", Key: "sk-channel-first", Models: "first-model", Group: "default", Setting: &userKeyMode}
	second := Channel{Id: 931002, Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Name: "second", Key: "sk-channel-second", Models: "second-model", Group: "default", Setting: &userKeyMode}
	require.NoError(t, first.Insert())
	require.NoError(t, second.Insert())
	require.NoError(t, errorOnlyUpsert(7, "sk-user-7"))

	storedFirst, err := GetChannelById(first.Id, true)
	require.NoError(t, err)
	storedSecond, err := GetChannelById(second.Id, true)
	require.NoError(t, err)
	require.True(t, storedFirst.RequiresUserUpstreamKey())
	require.True(t, storedSecond.RequiresUserUpstreamKey())

	key, ok := GetUserUpstreamKey(7)
	assert.True(t, ok)
	assert.Equal(t, "sk-user-7", key)

	_, ok = GetUserUpstreamKey(8)
	assert.False(t, ok)

	taskWithKey := &Task{UserId: 7, PrivateData: TaskPrivateData{Key: "sk-task-7"}}
	key, ok = ResolveTaskChannelKey(storedFirst, taskWithKey)
	assert.True(t, ok)
	assert.Equal(t, "sk-task-7", key, "a saved task keeps the credential that submitted it")

	taskWithoutKey := &Task{UserId: 7}
	key, ok = ResolveTaskChannelKey(storedSecond, taskWithoutKey)
	assert.True(t, ok)
	assert.Equal(t, "sk-user-7", key, "a mode channel polls with the owner's single user key")

	strangerTask := &Task{UserId: 8}
	_, ok = ResolveTaskChannelKey(storedFirst, strangerTask)
	assert.False(t, ok, "a per-user channel never falls back to the shared credential")

	plain := Channel{Id: 931003, Type: constant.ChannelTypeOpenAI, Status: common.ChannelStatusEnabled, Name: "plain", Key: "sk-channel", Models: "plain-model", Group: "default"}
	require.NoError(t, plain.Insert())
	assert.False(t, plain.RequiresUserUpstreamKey())

	key, ok = ResolveTaskChannelKey(&plain, strangerTask)
	assert.True(t, ok)
	assert.Equal(t, "sk-channel", key, "ordinary channels still poll with the shared credential")
}

func TestUpsertUserUpstreamKeyPersistsAndCaches(t *testing.T) {
	setupUserUpstreamKeyTest(t)

	createUserUpstreamKeyTestUser(t, 7, "user-key-upsert")
	createUserUpstreamKeyTestUser(t, 8, "user-key-upsert-other")
	InitUserUpstreamKeyCache()

	row, err := UpsertUserUpstreamKey(7, "  sk-user-7  ")
	require.NoError(t, err)
	require.NotNil(t, row)
	assert.Equal(t, "sk-user-7", row.Key)

	stored, err := GetUserUpstreamKeyRow(7)
	require.NoError(t, err)
	assert.Equal(t, "sk-user-7", stored.Key)
	assert.NotZero(t, stored.CreatedTime)
	assert.NotZero(t, stored.UpdatedTime)

	key, ok := GetUserUpstreamKey(7)
	assert.True(t, ok)
	assert.Equal(t, "sk-user-7", key)
	assert.True(t, UserHasUpstreamKey(7))
	assert.False(t, UserHasUpstreamKey(8))

	_, err = UpsertUserUpstreamKey(7, "sk-user-7-rotated")
	require.NoError(t, err)
	key, ok = GetUserUpstreamKey(7)
	assert.True(t, ok)
	assert.Equal(t, "sk-user-7-rotated", key)

	// The database path returns the same credential when memory cache is off.
	common.MemoryCacheEnabled = false
	key, ok = GetUserUpstreamKey(7)
	assert.True(t, ok)
	assert.Equal(t, "sk-user-7-rotated", key)

	require.NoError(t, DeleteUserUpstreamKey(7))
	_, err = GetUserUpstreamKeyRow(7)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	_, ok = GetUserUpstreamKey(7)
	assert.False(t, ok)
	require.ErrorIs(t, DeleteUserUpstreamKey(7), gorm.ErrRecordNotFound)

	_, err = UpsertUserUpstreamKey(7, "   ")
	require.Error(t, err)
	_, err = UpsertUserUpstreamKey(7, strings.Repeat("x", MaxUserUpstreamKeyLength+1))
	require.Error(t, err)
}

func TestHardDeleteUserRemovesUserUpstreamKey(t *testing.T) {
	setupUserUpstreamKeyTest(t)

	createUserUpstreamKeyTestUser(t, 7, "user-key-hard-delete")
	require.NoError(t, errorOnlyUpsert(7, "sk-user-7"))
	require.True(t, UserHasUpstreamKey(7))

	_, err := HardDeleteUserById(7)
	require.NoError(t, err)
	_, err = GetUserUpstreamKeyRow(7)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
}

// errorOnlyUpsert keeps fixtures compact where only the write success matters.
func errorOnlyUpsert(userId int, key string) error {
	_, err := UpsertUserUpstreamKey(userId, key)
	return err
}
