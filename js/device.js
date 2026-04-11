// ================================================================
//  DEVICE REGISTRY  (Phase 4)
// ================================================================

/** Generate or retrieve a stable per-device UUID stored in localStorage. */
function _generateDeviceId() {
  try {
    let id = localStorage.getItem('claude-tri-device-id');
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('claude-tri-device-id', id);
    }
    return id;
  } catch (_) { return 'unknown'; }
}

/**
 * Upsert this device into the devices table.
 * On a brand-new device this fires an INSERT → the DB trigger removes any
 * device beyond the 2-device limit automatically.
 * On a returning device it updates last_seen only (no trigger, no eviction).
 */
async function _registerDevice(session) {
  if (!_supabase || !session) return;
  try {
    const { error } = await _supabase.from('devices').upsert(
      {
        user_id:      session.user.id,
        device_id:    Entitlement.deviceId,
        last_seen:    new Date().toISOString(),
      },
      { onConflict: 'user_id,device_id' }
    );
    if (error) throw error;
    console.log('[Device] Registered/refreshed:', Entitlement.deviceId);
  } catch (err) {
    console.warn('[Device] Registration failed:', err.message);
  }
}

/**
 * Verify this device is still in the devices table.
 * Returns true if verified (or if Supabase is unreachable — fail open).
 * Returns false if the device was evicted (3rd-device kick).
 */
async function _verifyDevice(session) {
  if (!_supabase || !session) return true;
  try {
    const { data, error } = await _supabase
      .from('devices')
      .select('id')
      .eq('user_id',   session.user.id)
      .eq('device_id', Entitlement.deviceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      _handleDeviceRevoked();
      return false;
    }
    return true;
  } catch (err) {
    // Fail open — if Supabase is unreachable we don't lock the user out
    console.warn('[Device] Verification skipped (network issue):', err.message);
    return true;
  }
}

/**
 * Called when this device has been evicted by the 2-device limit.
 * Signs out locally and shows a clear message to the user.
 */
async function _handleDeviceRevoked() {
  console.warn('[Device] This device was evicted by the 2-device limit.');
  await _supabase.auth.signOut();
  // Show the auth modal with an explanatory info message
  _showAuthModal('signin');
  _showAuthMsg(
    'You were signed out because this account is active on 2 other devices. ' +
    'Sign in again to use this device (the oldest device will be removed).',
    'info'
  );
}
