// Roles: 'cashier' < 'owner' < 'superadmin'.
// A superadmin can do everything an owner can, and is invisible to everyone else: owners and cashiers never
// see the account in Staff & Accounts, the dashboard or the sign-in picker, and firestore.rules refuses them
// any read or write of it (so it isn't just hidden on screen).

/** Owner-level access: everything an owner can do (owners and superadmins). */
export const isOwnerLevel = (user) => user?.role === 'owner' || user?.role === 'superadmin';

export const isSuperadmin = (user) => user?.role === 'superadmin';

export const roleLabel = (role) => ({ superadmin: 'Superadmin', owner: 'Owner' }[role] || 'Cashier');

/** Staff accounts the viewer is allowed to see: superadmin accounts only show to superadmins. */
export const visibleUsers = (users, viewer) => (isSuperadmin(viewer) ? users : users.filter((u) => u.role !== 'superadmin'));

/** Query filter for the users list, so the database itself never sends superadmin accounts to non-superadmins. */
export const usersQuery = (viewer) => (isSuperadmin(viewer) ? {} : { where: [['role', '!=', 'superadmin']] });
