package controller

import (
	"errors"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// userUpstreamKeyPreview masks a stored credential so status responses can
// identify a key without disclosing it. Only the security-proof reveal endpoint
// returns the key itself.
func userUpstreamKeyPreview(key string) string {
	runes := []rune(key)
	if len(runes) <= 8 {
		return "****"
	}
	return string(runes[:4]) + "..." + string(runes[len(runes)-4:])
}

type userUpstreamKeyStatus struct {
	Configured  bool   `json:"configured"`
	KeyPreview  string `json:"key_preview"`
	UpdatedTime int64  `json:"updated_time"`
}

func buildUserUpstreamKeyStatus(row *model.UserUpstreamKey) userUpstreamKeyStatus {
	if row == nil || row.Key == "" {
		return userUpstreamKeyStatus{}
	}
	return userUpstreamKeyStatus{
		Configured:  true,
		KeyPreview:  userUpstreamKeyPreview(row.Key),
		UpdatedTime: row.UpdatedTime,
	}
}

// writeUserUpstreamKeyError maps persistence failures to generic messages so a
// driver error can never echo credential material to the client.
func writeUserUpstreamKeyError(c *gin.Context, err error) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiErrorI18n(c, i18n.MsgUserNotExists)
		return
	}
	common.ApiErrorI18n(c, i18n.MsgDatabaseError)
}

func parseUpstreamKeyTargetUserId(c *gin.Context) (int, bool) {
	userId, err := strconv.Atoi(c.Param("id"))
	if err != nil || userId <= 0 {
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return 0, false
	}
	return userId, true
}

// requireManageableUser loads the target user and enforces the same role rule as
// the rest of user management: an operator can only manage lower-privileged
// accounts, while root can manage everyone.
func requireManageableUser(c *gin.Context, userId int) (*model.User, bool) {
	user, err := model.GetUserById(userId, false)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiErrorI18n(c, i18n.MsgUserNotExists)
		return nil, false
	}
	if err != nil {
		common.ApiErrorI18n(c, i18n.MsgDatabaseError)
		return nil, false
	}
	if !canManageTargetRole(c.GetInt("role"), user.Role) {
		common.ApiErrorI18n(c, i18n.MsgUserNoPermissionHigherLevel)
		return nil, false
	}
	return user, true
}

// AdminGetUserUpstreamKey returns the masked status of one managed user's key.
func AdminGetUserUpstreamKey(c *gin.Context) {
	userId, ok := parseUpstreamKeyTargetUserId(c)
	if !ok {
		return
	}
	if _, ok := requireManageableUser(c, userId); !ok {
		return
	}
	row, err := model.GetUserUpstreamKeyRow(userId)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiSuccess(c, userUpstreamKeyStatus{})
		return
	}
	if err != nil {
		writeUserUpstreamKeyError(c, err)
		return
	}
	common.ApiSuccess(c, buildUserUpstreamKeyStatus(row))
}

// AdminRevealUserUpstreamKey returns one managed user's full key after step-up.
func AdminRevealUserUpstreamKey(c *gin.Context) {
	userId, ok := parseUpstreamKeyTargetUserId(c)
	if !ok {
		return
	}
	target, ok := requireManageableUser(c, userId)
	if !ok {
		return
	}
	if requireAdminUserProof(c, service.VerificationScopeAdminUserUpstreamKeyRead, service.AdminUserContext{UserID: target.Id}) == nil {
		return
	}
	row, err := model.GetUserUpstreamKeyRow(target.Id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiErrorI18n(c, i18n.MsgNotFound)
		return
	}
	if err != nil {
		writeUserUpstreamKeyError(c, err)
		return
	}
	recordManageAuditFor(c, target.Id, "user.upstream_key_view", map[string]any{"success": true, "username": target.Username})
	common.ApiSuccess(c, gin.H{"key": row.Key})
}
