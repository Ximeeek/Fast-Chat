import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	Permission,
	Role,
	ROLE_PERMISSIONS,
	hasPermission
} from '../src/lib/types/permissions.ts';

describe('Role & Permission UI Helpers (UX Visibility)', () => {
	test('Permission enum includes all core administrative operations', () => {
		const expectedPermissions = [
			'KickPeer',
			'MutePeer',
			'SetRoomPassword',
			'TransferOwnership',
			'LockRoom',
			'ManageChatVisibility',
			'ManageFileVisibility'
		];

		for (const perm of expectedPermissions) {
			assert.equal(Permission[perm as keyof typeof Permission], perm);
		}
	});

	test('ROLE_PERMISSIONS matrix grants all permissions to Owner and none to Participant', () => {
		assert.equal(ROLE_PERMISSIONS[Role.Owner].length, 7);
		assert.deepEqual(ROLE_PERMISSIONS[Role.Participant], []);

		for (const perm of Object.values(Permission)) {
			assert.ok(ROLE_PERMISSIONS[Role.Owner].includes(perm));
			assert.ok(!ROLE_PERMISSIONS[Role.Participant].includes(perm));
		}
	});

	test('hasPermission grants permissions to Owner role', () => {
		assert.equal(hasPermission(Role.Owner, Permission.SetRoomPassword), true);
		assert.equal(hasPermission(Role.Owner, Permission.KickPeer), true);
		assert.equal(hasPermission(Role.Owner, Permission.MutePeer), true);
		assert.equal(hasPermission(Role.Owner, Permission.TransferOwnership), true);
		assert.equal(hasPermission(Role.Owner, Permission.LockRoom), true);
		assert.equal(hasPermission(Role.Owner, Permission.ManageChatVisibility), true);
		assert.equal(hasPermission(Role.Owner, Permission.ManageFileVisibility), true);
	});

	test('hasPermission denies permissions to Participant role', () => {
		assert.equal(hasPermission(Role.Participant, Permission.SetRoomPassword), false);
		assert.equal(hasPermission(Role.Participant, Permission.KickPeer), false);
		assert.equal(hasPermission(Role.Participant, Permission.MutePeer), false);
		assert.equal(hasPermission(Role.Participant, Permission.TransferOwnership), false);
		assert.equal(hasPermission(Role.Participant, Permission.LockRoom), false);
		assert.equal(hasPermission(Role.Participant, Permission.ManageChatVisibility), false);
		assert.equal(hasPermission(Role.Participant, Permission.ManageFileVisibility), false);
	});

	test('hasPermission safely returns false for null, undefined, or unknown roles', () => {
		assert.equal(hasPermission(null, Permission.SetRoomPassword), false);
		assert.equal(hasPermission(undefined, Permission.SetRoomPassword), false);
		// @ts-expect-error test unknown role fallback
		assert.equal(hasPermission('UnknownRole', Permission.SetRoomPassword), false);
	});
});
