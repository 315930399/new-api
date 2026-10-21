package model

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	kitdto "github.com/QuantumNous/new-api/relaykit/dto"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UserUpstreamKey is the single upstream credential a user sends through every
// channel that runs in per-user key mode. Ownership is user-scoped: the record
// has no channel association, and the same key is reused for every channel that
// enables the mode.
type UserUpstreamKey struct {
	Id          int    `json:"id"`
	UserId      int    `json:"user_id" gorm:"not null;uniqueIndex"`
	Key         string `json:"-" gorm:"type:text;not null"`
	CreatedTime int64  `json:"created_time" gorm:"bigint"`
	UpdatedTime int64  `json:"updated_time" gorm:"bigint"`
}

// MaxUserUpstreamKeyLength bounds one stored user key. It comfortably covers
// structured credentials (Vertex AI service-account JSON) while keeping a single
// credential from being used as arbitrary storage.
const MaxUserUpstreamKeyLength = 8192

// ErrUserUpstreamKeyRequired explains an empty channel selection: every candidate
// channel runs in per-user key mode and the requesting user has no key at all.
var ErrUserUpstreamKeyRequired = errors.New("no available channel for this user: the candidate channels require a per-user key that this account has not configured")

// userUpstreamKeyCache maps user ID -> upstream key so channel selection and key
// resolution never query the database per candidate while memory cache is
// enabled. The whole map is rebuilt on channel cache sync, matching how channel
// credentials are cached. A nil map means "not loaded"; readers fall back to the
// database so correctness never depends on the cache being warm.
var (
	userUpstreamKeyLock  sync.RWMutex
	userUpstreamKeyCache map[int]string
)

// InitUserUpstreamKeyCache reloads every user upstream key into memory.
func InitUserUpstreamKeyCache() {
	rows := make([]UserUpstreamKey, 0)
	if err := DB.Select("user_id", "key").Find(&rows).Error; err != nil {
		common.SysError("failed to load user upstream keys: " + err.Error())
		return
	}
	next := make(map[int]string, len(rows))
	for _, row := range rows {
		if row.Key != "" {
			next[row.UserId] = row.Key
		}
	}
	userUpstreamKeyLock.Lock()
	userUpstreamKeyCache = next
	userUpstreamKeyLock.Unlock()
}

// clearUserUpstreamKeyCache drops the cache when no channel uses per-user keys.
func clearUserUpstreamKeyCache() {
	userUpstreamKeyLock.Lock()
	userUpstreamKeyCache = nil
	userUpstreamKeyLock.Unlock()
}

// cacheUserUpstreamKey updates one cache entry after a successful write. It is a
// no-op when the cache was never loaded, because the next channel cache sync
// will read the row from the database.
func cacheUserUpstreamKey(userId int, key string) {
	userUpstreamKeyLock.Lock()
	defer userUpstreamKeyLock.Unlock()
	if userUpstreamKeyCache == nil {
		return
	}
	if key == "" {
		delete(userUpstreamKeyCache, userId)
		return
	}
	userUpstreamKeyCache[userId] = key
}

// RequiresUserUpstreamKey reports whether the channel only serves requests whose
// user has configured an upstream key. The raw setting is checked first so the
// common case, a channel that never enables the mode, does not parse JSON for
// every candidate during channel selection.
func (channel *Channel) RequiresUserUpstreamKey() bool {
	if channel == nil || channel.Setting == nil || *channel.Setting == "" {
		return false
	}
	if !strings.Contains(*channel.Setting, "user_key_mode") {
		return false
	}
	var setting kitdto.ChannelSettings
	if err := common.Unmarshal([]byte(*channel.Setting), &setting); err != nil {
		return false
	}
	return setting.UserKeyMode
}

// GetUserUpstreamKey returns the key a user sends to every per-user key channel.
func GetUserUpstreamKey(userId int) (string, bool) {
	if userId <= 0 {
		return "", false
	}
	if common.MemoryCacheEnabled {
		userUpstreamKeyLock.RLock()
		if userUpstreamKeyCache != nil {
			key, ok := userUpstreamKeyCache[userId]
			userUpstreamKeyLock.RUnlock()
			return key, ok && key != ""
		}
		userUpstreamKeyLock.RUnlock()
	}
	var row UserUpstreamKey
	if err := DB.Select("key").Where("user_id = ?", userId).First(&row).Error; err != nil {
		return "", false
	}
	return row.Key, row.Key != ""
}

// UserHasUpstreamKey reports whether the user has configured any upstream key.
// Channel selection only needs presence, but it deliberately reuses the same
// cached lookup so a request never reads the database twice.
func UserHasUpstreamKey(userId int) bool {
	_, ok := GetUserUpstreamKey(userId)
	return ok
}

// ResolveTaskChannelKey returns the upstream credential a saved task must use.
// A task keeps the key that submitted it across key rotation. When that key was
// not persisted (older tasks), a per-user channel falls back to the owner's
// current key, never to the shared channel credential. ok is false when the
// channel needs a per-user key and neither source provides one.
func ResolveTaskChannelKey(channel *Channel, task *Task) (key string, ok bool) {
	if task != nil && task.PrivateData.Key != "" {
		return task.PrivateData.Key, true
	}
	if channel == nil {
		return "", false
	}
	if channel.RequiresUserUpstreamKey() {
		if task != nil {
			if key, ok := GetUserUpstreamKey(task.UserId); ok {
				return key, true
			}
		}
		return "", false
	}
	return channel.Key, true
}

// GetUserUpstreamKeyRow loads the key one user has configured.
func GetUserUpstreamKeyRow(userId int) (*UserUpstreamKey, error) {
	row := &UserUpstreamKey{}
	err := DB.Where("user_id = ?", userId).First(row).Error
	if err != nil {
		return nil, err
	}
	return row, nil
}

// UpsertUserUpstreamKey creates or replaces the single key a user sends to every
// per-user key channel. It returns the persisted row shape for the caller's
// status response; callers must never serialize Key directly.
func UpsertUserUpstreamKey(userId int, key string) (*UserUpstreamKey, error) {
	row, err := UpsertUserUpstreamKeyWithTx(DB, userId, key)
	if err != nil {
		return nil, err
	}
	cacheUserUpstreamKey(userId, row.Key)
	return row, nil
}

// UpsertUserUpstreamKeyWithTx is the transactional write used when a key is
// saved together with the owning user. The caller must publish the cache after
// the transaction commits.
func UpsertUserUpstreamKeyWithTx(tx *gorm.DB, userId int, key string) (*UserUpstreamKey, error) {
	if userId <= 0 {
		return nil, errors.New("invalid user id")
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, errors.New("key cannot be empty")
	}
	if len(key) > MaxUserUpstreamKeyLength {
		return nil, fmt.Errorf("key must not exceed %d characters", MaxUserUpstreamKeyLength)
	}
	var user User
	if err := tx.Select("id").First(&user, userId).Error; err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	row := &UserUpstreamKey{
		UserId:      userId,
		Key:         key,
		CreatedTime: now,
		UpdatedTime: now,
	}
	err := tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.Assignments(map[string]any{"key": key, "updated_time": now}),
	}).Create(row).Error
	if err != nil {
		return nil, err
	}
	return row, nil
}

// DeleteUserUpstreamKey removes the key a user configured.
func DeleteUserUpstreamKey(userId int) error {
	if err := DeleteUserUpstreamKeyWithTx(DB, userId); err != nil {
		return err
	}
	cacheUserUpstreamKey(userId, "")
	return nil
}

// DeleteUserUpstreamKeyWithTx is the transactional removal used when the key is
// cleared together with the owning user update.
func DeleteUserUpstreamKeyWithTx(tx *gorm.DB, userId int) error {
	result := tx.Where("user_id = ?", userId).Delete(&UserUpstreamKey{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// PublishUserUpstreamKeyCache refreshes one user's cache entry from the database
// after a transaction commits. A missing row removes the entry.
func PublishUserUpstreamKeyCache(userId int) {
	if userId <= 0 || !common.MemoryCacheEnabled {
		return
	}
	row, err := GetUserUpstreamKeyRow(userId)
	if err != nil {
		cacheUserUpstreamKey(userId, "")
		return
	}
	cacheUserUpstreamKey(userId, row.Key)
}

// userUpstreamKeyFilter returns the user-key filter carried by a selection.
func userUpstreamKeyFilter(filters []dto.ChannelFilter) (dto.ChannelFilter, bool) {
	for _, filter := range filters {
		if filter.Kind == dto.FilterUserUpstreamKey {
			return filter, true
		}
	}
	return dto.ChannelFilter{}, false
}
